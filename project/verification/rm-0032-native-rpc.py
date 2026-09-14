"""Linux-only transport for an already-owned unbuffered App Server process.

No launch, login, model admission decision, stderr reader, kill, wait or OS
settlement is implemented here. stdin/stdout must be exact io.FileIO objects
(Popen bufsize=0). Ownership of these pipe handles transfers to NativeRpc;
caller must not concurrently use/close them. O_NONBLOCK + selector readiness
bounds every read/write, including backpressure; no buffered flush is used.
"""
import collections
import io
import json
import math
import os
import selectors
import stat
import sys
import threading
import time
import uuid

FRAME_CAP = 3 * 1024 * 1024
QUEUE_BYTES = 8 * 1024 * 1024
IMAGE_FRAME_CAP = 12 * 1024 * 1024
IMAGE_QUEUE_BYTES = 32 * 1024 * 1024
QUEUE_COUNT = 64
SERVER_IDS = 4096  # > NativeConversation's 256 turns * (8 calls + 4 refusals).
PENDING_COUNT = 32
CUSTODY = frozenset({"initialize", "permissionProfile/list", "command/exec", "account/read", "model/list", "modelProvider/capabilities/read"})
MODEL = frozenset({"thread/start", "turn/start"})


# Public fixed names only. Unknown key names and all values stay private.
ENVELOPE_KEYS = ("id", "method", "params", "result", "error", "jsonrpc", "trace", "_meta", "metadata", "timestamp", "level", "target", "fields", "span", "spans", "type", "data", "event", "name")
ENVELOPE_METHODS = frozenset({"configWarning", "deprecationNotice", "account/updated", "account/rateLimits/updated", "account/chatgptAuthTokens/refresh"})

def envelope_shape(value=None, seen=False):
    def kind(item):
        return {dict: "object", list: "array", type(None): "null", str: "string", int: "number", float: "number", bool: "boolean"}.get(type(item), "not_seen")
    result = {"type": "not_seen", "keys": 0, "unknownKeys": 0, "method": "not_seen", "idType": "not_seen", "paramsType": "not_seen"}
    if not seen: return result
    result["type"] = kind(value)
    if type(value) is not dict: return result
    result["keys"] = sum(1 << index for index, name in enumerate(ENVELOPE_KEYS) if name in value)
    result["unknownKeys"] = min(32, sum(name not in ENVELOPE_KEYS for name in value))
    result["idType"] = kind(value["id"]) if "id" in value else "absent"
    result["paramsType"] = kind(value["params"]) if "params" in value else "absent"
    method = value.get("method")
    result["method"] = "absent" if "method" not in value else "not_string" if type(method) is not str else method if method in ENVELOPE_METHODS else "other"
    return result


class NativeRpcError(Exception):
    def __init__(self, code, unknown=False, site="none", shape=None):
        super().__init__(code)
        self.code, self.unknown, self.site = code, unknown, site
        self.shape = envelope_shape() if shape is None else shape


def profile_limits(profile):
    if type(profile) is not str or profile not in {"text", "image"}:
        raise NativeRpcError("CONFIG_REFUSED")
    return (FRAME_CAP, QUEUE_BYTES) if profile == "text" else (IMAGE_FRAME_CAP, IMAGE_QUEUE_BYTES)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError()
        result[key] = value
    return result


def _float(value):
    result = float(value)
    if not math.isfinite(result): raise ValueError()
    return result


def _constant(_):
    raise ValueError()


def native_id(value):
    try:
        return (type(value) is int and -(2**63) <= value < 2**63 or
                type(value) is str and 0 < len(value.encode("utf-8")) <= 128)
    except UnicodeError: return False


def decode_frame(line, *, profile="text"):
    """Strict bounded JSON-line codec; raises fixed error, never raw contents."""
    frame_cap, _ = profile_limits(profile)
    site, shape = "line", envelope_shape()
    try:
        if type(line) is not bytes or not 1 < len(line) <= frame_cap or not line.endswith(b"\n"): raise ValueError()
        site = "json"
        result = json.loads(line.decode("utf-8", "strict"), object_pairs_hook=_pairs, parse_constant=_constant, parse_float=_float)
        shape = envelope_shape(result, seen=True)
        site = "envelope"
        if type(result) is not dict or set(result) - {"id", "method", "params", "result", "error", "jsonrpc", "emittedAtMs"}: raise ValueError()
        site = "marker"
        if "jsonrpc" in result and result["jsonrpc"] != "2.0": raise ValueError()
        # A validated transport marker is not part of the App Server payload
        # passed to NativeConversation's exact request/event schema.
        result.pop("jsonrpc", None)
        # Installed0.153.4 ServerNotification.json common properties include
        # optional int64 emittedAtMs outside the81 notification variants.
        # This transport timestamp grants no semantic authority; consume it only
        # on notifications, then preserve the existing strict engine payload.
        if "emittedAtMs" in result:
            site = "payload"
            stamp = result["emittedAtMs"]
            if type(result.get("method")) is not str or "id" in result or "result" in result or "error" in result or type(stamp) is not int or not -(2**63) <= stamp < 2**63: raise ValueError()
            del result["emittedAtMs"]
        # JSON escaped lone surrogates are not valid protocol text either.
        site = "unicode"
        json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")
        site = "payload"
        if "method" in result:
            if type(result["method"]) is not str or not 0 < len(result["method"].encode()) <= 256 or "result" in result or "error" in result: raise ValueError()
            if "params" in result and type(result["params"]) is not dict: raise ValueError()
            if "id" in result and not native_id(result["id"]): raise ValueError()
        else:
            if not native_id(result.get("id")) or "params" in result or ("error" in result) == ("result" in result): raise ValueError()
            if "result" in result and type(result["result"]) is not dict: raise ValueError()
            if "error" in result and (type(result["error"]) is not dict or type(result["error"].get("code")) is not int): raise ValueError()
        return result
    except Exception:
        raise NativeRpcError("PROTOCOL_REFUSED", site=site, shape=shape) from None


def encode_frame(frame, *, profile="text"):
    frame_cap, _ = profile_limits(profile)
    try:
        value = json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
        if len(value) > frame_cap: raise ValueError()
        return value
    except Exception:
        raise NativeRpcError("BOUNDS_REFUSED") from None


class NativeRpc:
    def __init__(self, proc, profile="text"):
        self._frame_cap, self._queue_cap = profile_limits(profile)
        self._profile = profile
        self._phase, self._code, self._unknown = "custody", "OK", False
        self._closed, self._input_closed, self._eof = False, False, False
        self._buffer, self._queue, self._queued_bytes = bytearray(), collections.deque(), 0
        self._deferred_count, self._deferred_bytes, self._drained_bytes = 0, 0, 0
        self._seen, self._pending = set(), {}
        self._lock = threading.Lock()
        self._initialized, self._init_ack = False, False
        self._serial, self._prefix = 0, "native-" + uuid.uuid4().hex + "-"
        self._reads, self._writes, self._responses = 0, 0, 0
        self._read_bytes, self._write_bytes = 0, 0
        self._operation = "none"
        self._failure_shape = envelope_shape()
        self._failure = {"code": "OK", "site": "none", "operation": "none", "phase": "custody"}
        try:
            if sys.platform != "linux" or type(proc.stdin) is not io.FileIO or type(proc.stdout) is not io.FileIO: raise ValueError()
            if proc.stdin.closed or proc.stdout.closed or not proc.stdin.writable() or not proc.stdout.readable(): raise ValueError()
            self._stdin, self._stdout = proc.stdin, proc.stdout
            self._write_fd, self._read_fd = proc.stdin.fileno(), proc.stdout.fileno()
            if self._write_fd == self._read_fd or any(not stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (self._write_fd, self._read_fd)): raise ValueError()
            os.set_blocking(self._write_fd, False)
            os.set_blocking(self._read_fd, False)
        except Exception:
            raise NativeRpcError("CONFIG_REFUSED") from None

    def _fail(self, code, unknown=False, site="phase", shape=None):
        if self._failure["code"] == "OK":
            self._failure_shape = envelope_shape() if shape is None else dict(shape)
            self._failure = {"code": code, "site": site, "operation": self._operation, "phase": self._phase}
        self._code, self._unknown = code, self._unknown or unknown
        self._phase = "poisoned"
        self._queue.clear(); self._buffer.clear(); self._queued_bytes = 0
        raise NativeRpcError(code, self._unknown) from None

    def _check(self):
        if self._closed or self._input_closed or self._phase in {"poisoned", "shutdown"}:
            raise NativeRpcError(self._code if self._phase == "poisoned" else "CLOSED", self._unknown)

    def _deadline(self, seconds):
        self._check()
        maximum = 300 if self._profile == "image" else 125
        if type(seconds) not in (int, float) or not 0 < seconds <= maximum or not math.isfinite(seconds):
            self._fail("BOUNDS_REFUSED")
        return time.monotonic() + seconds

    def _time(self, deadline):
        self._check()
        remaining = deadline - time.monotonic()
        if remaining <= 0: self._fail("TRANSPORT_UNKNOWN", True, "deadline")
        return remaining

    def _ingest(self):
        try: data = os.read(self._read_fd, 65536)
        except BlockingIOError: return
        except OSError: self._fail("TRANSPORT_UNKNOWN", True, "read")
        self._read_bytes += len(data)
        if not data: self._eof = True; return
        self._buffer.extend(data)
        while True:
            end = self._buffer.find(b"\n")
            if end < 0:
                if len(self._buffer) >= self._frame_cap: self._fail("BOUNDS_REFUSED", True)
                return
            size = end + 1
            if size > self._frame_cap: self._fail("BOUNDS_REFUSED", True)
            raw = bytes(self._buffer[:size]); del self._buffer[:size]
            try: frame = decode_frame(raw, profile=self._profile)
            except NativeRpcError as error: self._fail("PROTOCOL_REFUSED", True, error.site, error.shape)
            if "method" in frame and "id" in frame:
                if self._phase != "model": self._fail("PHASE_REFUSED", True)
                key = (type(frame["id"]), frame["id"])
                if key in self._seen: self._fail("PROTOCOL_REFUSED", True)
                if len(self._seen) >= SERVER_IDS or len(self._pending) >= PENDING_COUNT: self._fail("BOUNDS_REFUSED", True)
                self._seen.add(key); self._pending[key] = "queued"
            if len(self._queue) + self._deferred_count >= QUEUE_COUNT or self._queued_bytes + self._deferred_bytes + size > self._queue_cap: self._fail("BOUNDS_REFUSED", True)
            self._queue.append((frame, size)); self._queued_bytes += size; self._reads += 1

    def _wait(self, deadline, writing=False):
        if self._eof: self._fail("TRANSPORT_UNKNOWN", True, "eof")
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(self._read_fd, selectors.EVENT_READ)
                if writing: selector.register(self._write_fd, selectors.EVENT_WRITE)
                ready = selector.select(self._time(deadline))
                self._time(deadline)
                if not ready: self._fail("TRANSPORT_UNKNOWN", True, "deadline")
                writable = False
                for item, _ in ready:
                    if item.fd == self._read_fd: self._ingest()
                    else: writable = True
                return writable
        except NativeRpcError: raise
        except Exception: self._fail("TRANSPORT_UNKNOWN", True, "selector")

    def _write(self, frame, deadline):
        try: data = encode_frame(frame, profile=self._profile)
        except NativeRpcError: self._fail("BOUNDS_REFUSED")
        offset = 0
        while offset < len(data):
            self._time(deadline)
            if not self._wait(deadline, writing=True): continue
            self._time(deadline)
            try: count = os.write(self._write_fd, data[offset:offset + 65536])
            except BlockingIOError: continue
            except OSError: self._fail("TRANSPORT_UNKNOWN", True, "write")
            if count <= 0: self._fail("TRANSPORT_UNKNOWN", True, "write")
            offset += count; self._write_bytes += count
        self._time(deadline); self._writes += 1

    def _pop(self, deadline):
        while not self._queue:
            self._time(deadline)
            if self._eof: self._fail("TRANSPORT_UNKNOWN", True, "eof")
            self._wait(deadline)
        self._time(deadline)
        frame, size = self._queue.popleft(); self._queued_bytes -= size
        return frame, size

    def _enter(self):
        self._check()
        if not self._lock.acquire(blocking=False): self._fail("CONCURRENT_REFUSED", True)

    def exchange(self, method, params, seconds=10.0):
        self._enter()
        try:
            self._operation = method if type(method) is str and method in CUSTODY | MODEL else "other"
            deadline = self._deadline(seconds)
            if type(method) is not str or method not in (CUSTODY if self._phase == "custody" else MODEL) or type(params) is not dict:
                self._fail("PHASE_REFUSED")
            if method == "initialize":
                if self._init_ack or self._serial: self._fail("PHASE_REFUSED")
            elif not self._initialized: self._fail("PHASE_REFUSED")
            self._serial += 1; request_id = self._prefix + str(self._serial)
            self._write({"id": request_id, "method": method, "params": params}, deadline)
            deferred = collections.deque(); deferred_bytes = 0
            try:
                while True:
                    frame, size = self._pop(deadline)
                    if "method" in frame:
                        deferred.append((frame, size)); deferred_bytes += size
                        self._deferred_count, self._deferred_bytes = len(deferred), deferred_bytes
                        if len(deferred) + len(self._queue) > QUEUE_COUNT or deferred_bytes + self._queued_bytes > self._queue_cap: self._fail("BOUNDS_REFUSED", True)
                        continue
                    if type(frame["id"]) is not str or frame["id"] != request_id: self._fail("PROTOCOL_REFUSED", True, "response_id")
                    if "error" in frame: return None, frame["error"]["code"]
                    if method == "initialize": self._init_ack = True
                    return frame["result"], None
            finally:
                if self._phase != "poisoned":
                    self._queue.extendleft(reversed(deferred)); self._queued_bytes += deferred_bytes
                self._deferred_count, self._deferred_bytes = 0, 0
        finally: self._lock.release()

    def initialized(self, seconds=10.0):
        self._operation = "initialized"
        self._enter()
        try:
            if self._phase != "custody" or not self._init_ack or self._initialized: self._fail("PHASE_REFUSED")
            self._write({"method": "initialized"}, self._deadline(seconds)); self._initialized = True
        finally: self._lock.release()

    def admit_model(self):
        """Trusted controller only, after unchanged custody protocol succeeded.
        This method checks transport phase, not semantic credential custody."""
        self._operation = "admit_model"
        self._enter()
        try:
            if self._phase != "custody" or not self._initialized or self._pending: self._fail("PHASE_REFUSED")
            self._phase = "model"
        finally: self._lock.release()

    def next_frame(self, seconds=10.0):
        self._operation = "next_frame"
        self._enter()
        try:
            if self._phase != "model": self._fail("PHASE_REFUSED")
            frame, _ = self._pop(self._deadline(seconds))
            if "method" not in frame: self._fail("PROTOCOL_REFUSED", True)
            if "id" in frame:
                key = (type(frame["id"]), frame["id"])
                if self._pending.get(key) != "queued": self._fail("PROTOCOL_REFUSED", True)
                self._pending[key] = "delivered"
            return frame
        finally: self._lock.release()

    def respond(self, request_id, result, seconds=10.0):
        self._operation = "respond"
        self._enter()
        try:
            if self._phase != "model" or not native_id(request_id) or type(result) is not dict: self._fail("PHASE_REFUSED")
            key = (type(request_id), request_id)
            if self._pending.get(key) != "delivered": self._fail("PROTOCOL_REFUSED", True)
            self._pending[key] = "responding"  # Consumed before any possibly partial write.
            self._write({"id": request_id, "result": result}, self._deadline(seconds))
            del self._pending[key]; self._responses += 1
        finally: self._lock.release()

    def close_input(self):
        """Only unbuffered pipe EOF, never an App Server settlement assertion."""
        if not self._input_closed:
            self._input_closed = True
            try: self._stdin.close()
            except OSError: self._code, self._unknown = "CLOSE_UNKNOWN", True

    def close(self):
        self.close_input(); self._closed = True
        try: self._stdout.close()
        except OSError: self._code, self._unknown = "CLOSE_UNKNOWN", True
        self._queue.clear(); self._buffer.clear(); self._queued_bytes = 0
        self._seen.clear(); self._pending.clear()

    def drain_to_eof(self, seconds):
        """Same-reader bounded private discard after EOF to stdin, even poisoned.
        Returns observed stdout EOF only. Caller separately waits/reaps process.
        Timeout is unknown, never a reason to resume exchange or tool replies."""
        if not self._input_closed or self._closed or not self._lock.acquire(blocking=False):
            raise NativeRpcError("PHASE_REFUSED", self._unknown)
        try:
            self._phase = "shutdown"
            self._drained_bytes += len(self._buffer) + self._queued_bytes
            self._buffer.clear(); self._queue.clear(); self._queued_bytes = 0
            if type(seconds) not in (int, float) or not 0 < seconds <= 125 or not math.isfinite(seconds):
                self._code, self._unknown = "SHUTDOWN_UNKNOWN", True
                return False
            deadline = time.monotonic() + seconds
            with selectors.DefaultSelector() as selector:
                selector.register(self._read_fd, selectors.EVENT_READ)
                while not self._eof:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0: break
                    if not selector.select(remaining) or time.monotonic() >= deadline: break
                    try: data = os.read(self._read_fd, 65536)
                    except BlockingIOError: continue
                    if not data: self._eof = True; break
                    self._drained_bytes += len(data)
            if not self._eof: self._code, self._unknown = "SHUTDOWN_UNKNOWN", True
            return self._eof
        except Exception:
            self._code, self._unknown = "SHUTDOWN_UNKNOWN", True
            return False
        finally: self._lock.release()

    def metadata(self):
        return {"schema": "native-rpc-v1", "profile": self._profile, "frameCap": self._frame_cap, "queueByteCap": self._queue_cap, "phase": self._phase, "code": self._code, "unknown": self._unknown,
                "inputClosed": self._input_closed, "closed": self._closed, "framesRead": self._reads,
                "framesWritten": self._writes, "responsesWritten": self._responses, "queuedFrames": len(self._queue),
                "queuedBytes": self._queued_bytes, "pendingRequests": len(self._pending), "serverIds": len(self._seen),
                "stdoutEofObserved": self._eof, "shutdownDiscardedBytes": self._drained_bytes,
                "firstFailure": dict(self._failure), "failureEnvelope": dict(self._failure_shape), "bytesRead": self._read_bytes, "bytesWritten": self._write_bytes}
