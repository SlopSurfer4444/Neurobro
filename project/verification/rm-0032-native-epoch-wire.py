"""Linux private epoch NDJSON on caller-owned pipe descriptors.

No process launch, buffered stdio, logging, implicit descriptor close or OS
settlement. Sets O_NONBLOCK on the supplied pipe ends; caller must exclusively
own them and dispose of them after joining users of this codec. close() revokes
operations; blocked selectors notice within 50ms. It does not claim users joined.

Canonical JSON is the epoch protocol's strict subset of JSON.stringify: object
root, safe integer numbers only, scalar Unicode, compact UTF8 and JS object-key
order. Native int64 request IDs never cross this boundary. Nested history pages
remain strings in toolResult.contentItems. Unknown fields remain driver-owned.
"""
import json
import math
import os
import selectors
import stat
import sys
import threading
import time

FRAME_BYTES = 3 * 1024 * 1024  # excludes LF, matching standing-epoch-wire.ts
INPUT_FRAME_BYTES = 12 * 1024 * 1024
TOTAL_BYTES = 512 * 1024 * 1024
SAFE_INTEGER = 2**53 - 1
CODES = frozenset({"config", "closed", "frame", "bounds", "read", "write", "partial-eof", "concurrent-read", "concurrent-write", "timeout-value", "write-timeout"})

class EpochWireError(Exception):
    def __init__(self, code, unknown=False):
        self.code = code if type(code) is str and code in CODES else "frame"
        self.unknown = unknown is True
        super().__init__("EPOCH_WIRE_" + self.code.upper())

def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError()
        result[key] = value
    return result

def _non_integer(_): raise ValueError()

def _index(key):
    if key == "0": return 0
    if key.isascii() and key.isdecimal() and not key.startswith("0") and len(key) <= 10:
        value = int(key)
        if value < 2**32 - 1: return value
    return None

def _canonical(value, depth=0):
    if depth > 64: raise ValueError()
    if value is None or type(value) is bool: return value
    if type(value) is int:
        if abs(value) > SAFE_INTEGER: raise ValueError()
        return value
    if type(value) is str:
        value.encode("utf-8", "strict")
        return value
    if type(value) is list: return [_canonical(item, depth+1) for item in value]
    if type(value) is dict:
        if any(type(key) is not str for key in value): raise ValueError()
        indexes = sorted((number, key) for key in value if (number := _index(key)) is not None)
        keys = [key for _, key in indexes] + [key for key in value if _index(key) is None]
        return {key: _canonical(value[key], depth+1) for key in keys}
    raise ValueError()

def encode_frame(value, *, incoming=False, parallel=False):
    try:
        if type(value) is not dict or type(parallel) is not bool: raise ValueError()
        text = json.dumps(_canonical(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        visual = incoming and value.get("kind") == "turn" and "images" in value
        if incoming and parallel and set(value)=={'workerId','frame'} and type(value.get('workerId')) is str and type(value.get('frame')) is dict:
            inner=value['frame']
            visual=inner.get('kind')=='turn' and inner.get('purpose')=='conversation' and 'images' in inner
        cap = INPUT_FRAME_BYTES if visual else FRAME_BYTES
        if not 1 <= len(text) <= cap: raise EpochWireError("bounds")
        return text + b"\n"
    except EpochWireError: raise
    except Exception: raise EpochWireError("frame") from None

def decode_frame(line, *, parallel=False):
    try:
        if type(line) is not bytes or not 2 <= len(line) <= INPUT_FRAME_BYTES+1 or not line.endswith(b"\n"): raise ValueError()
        value = json.loads(line[:-1].decode("utf-8", "strict"), object_pairs_hook=_pairs,
                           parse_float=_non_integer, parse_constant=_non_integer)
        if encode_frame(value, incoming=True, parallel=parallel) != line: raise ValueError()
        return value
    except Exception: raise EpochWireError("frame") from None

class NativeEpochWire:
    def __init__(self, read_fd, write_fd, *, idle, parallel=False):
        self._state = threading.Lock()
        self._reader, self._writer = threading.Lock(), threading.Lock()
        self._closed = False
        self._fault = None
        self._unknown = False
        self._eof = False
        self._buffer = bytearray()
        self._read_bytes = self._write_bytes = self._reserved_bytes = 0
        self._read_frames = self._write_frames = 0
        self._write_active = False
        self._idle = idle
        self._parallel = parallel
        try:
            if sys.platform != "linux" or type(parallel) is not bool or type(read_fd) is not int or type(write_fd) is not int or read_fd < 0 or write_fd < 0 or read_fd == write_fd or idle is None: raise ValueError()
            if any(not stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (read_fd, write_fd)): raise ValueError()
            # Access modes must agree, not merely descriptor object types.
            import fcntl
            if fcntl.fcntl(read_fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY: raise ValueError()
            if fcntl.fcntl(write_fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_WRONLY: raise ValueError()
            os.set_blocking(read_fd, False); os.set_blocking(write_fd, False)
            self._read_fd, self._write_fd = read_fd, write_fd
        except Exception: raise EpochWireError("config") from None

    def _check_locked(self):
        if self._fault is not None: raise EpochWireError(self._fault, self._unknown)
        if self._closed: raise EpochWireError("closed", self._unknown)

    def _fail(self, code, unknown=False):
        with self._state:
            if self._fault is None: self._fault = code
            self._unknown |= unknown
            saved, uncertain = self._fault, self._unknown
        raise EpochWireError(saved, uncertain) from None

    def _deadline(self, seconds, maximum):
        with self._state: self._check_locked()
        if type(seconds) not in {int, float} or not math.isfinite(seconds) or not 0 < seconds <= maximum:
            raise EpochWireError("timeout-value")
        return time.monotonic() + seconds

    def _wait(self, selector, deadline, direction):
        with self._state: self._check_locked()
        left = deadline - time.monotonic()
        if left <= 0: return False
        try: selector.select(min(left, .05))
        except Exception: self._fail(direction, True)
        return True

    def receive(self, seconds):
        deadline = self._deadline(seconds, 1)
        if not self._reader.acquire(False): raise EpochWireError("concurrent-read")
        try:
            with selectors.DefaultSelector() as selector:
                try: selector.register(self._read_fd, selectors.EVENT_READ)
                except Exception: self._fail("read", True)
                while True:
                    with self._state: self._check_locked()
                    newline = self._buffer.find(b"\n")
                    # Once the actual read observed EOF, an expired wait cannot
                    # turn that fact back into IDLE. Complete frames still wait
                    # for a fresh decode budget before the trailing EOF report.
                    if self._eof and newline < 0:
                        if self._buffer: self._fail("partial-eof", True)
                        return None
                    if time.monotonic() >= deadline: return self._idle
                    if newline >= 0:
                        line = bytes(self._buffer[:newline+1])
                        try: value = decode_frame(line,parallel=self._parallel)
                        except EpochWireError: self._fail("frame")
                        with self._state:
                            self._check_locked()
                            if time.monotonic() >= deadline: return self._idle
                            del self._buffer[:newline+1];self._read_frames += 1
                        return value
                    blocked = False
                    try:
                        with self._state:
                            self._check_locked()
                            data = os.read(self._read_fd, min(65536, INPUT_FRAME_BYTES+1-len(self._buffer)))
                            self._read_bytes += len(data)
                            count = self._read_bytes
                    except BlockingIOError: blocked = True
                    except EpochWireError: raise
                    except Exception: self._fail("read", True)
                    if blocked:
                        if not self._wait(selector, deadline, "read"): return self._idle
                        continue
                    if count > TOTAL_BYTES: self._fail("bounds")
                    if not data: self._eof = True;continue
                    self._buffer.extend(data)
                    if len(self._buffer) > INPUT_FRAME_BYTES and b"\n" not in self._buffer: self._fail("bounds")
        except EpochWireError: raise
        except Exception: self._fail("read", True)
        finally:
            if self._closed or self._fault is not None:
                self._buffer[:] = b"\0" * len(self._buffer);self._buffer.clear()
            self._reader.release()

    def emit(self, value, seconds):
        deadline = self._deadline(seconds, 20)
        if not self._writer.acquire(False): raise EpochWireError("concurrent-write")
        try:
            frame = encode_frame(value)
            with self._state:
                self._check_locked()
                if self._reserved_bytes + len(frame) <= TOTAL_BYTES:
                    self._reserved_bytes += len(frame);self._write_active = True;allowed = True
                else: allowed = False
            if not allowed: self._fail("bounds")
            offset = 0
            with selectors.DefaultSelector() as selector:
                try: selector.register(self._write_fd, selectors.EVENT_WRITE)
                except Exception: self._fail("write", True)
                while offset < len(frame):
                    with self._state: self._check_locked()
                    if time.monotonic() >= deadline: self._fail("write-timeout", True)
                    blocked = False
                    try:
                        with self._state:
                            self._check_locked()
                            count = os.write(self._write_fd, memoryview(frame)[offset:])
                            self._write_bytes += count
                    except BlockingIOError: blocked = True
                    except EpochWireError: raise
                    except Exception: self._fail("write", True)
                    if blocked:
                        if not self._wait(selector, deadline, "write"): self._fail("write-timeout", True)
                        continue
                    if count <= 0: self._fail("write", True)
                    offset += count
                if time.monotonic() >= deadline: self._fail("write-timeout", True)
                with self._state:
                    self._check_locked();self._write_frames += 1
                return True
        except EpochWireError: raise
        except Exception: self._fail("write", True)
        finally:
            with self._state:self._write_active = False
            self._writer.release()

    def close(self):
        with self._state:
            self._closed = True
            self._unknown |= self._write_active
        if self._reader.acquire(False):
            try:self._buffer[:] = b"\0" * len(self._buffer);self._buffer.clear()
            finally:self._reader.release()

    def metadata(self):
        with self._state:
            return {"closed":self._closed,"code":self._fault or ("closed" if self._closed else "OK"),
                    "unknown":self._unknown,"eof":self._eof,"bytesRead":self._read_bytes,
                    "bytesWritten":self._write_bytes,"bytesReserved":self._reserved_bytes,
                    "framesRead":self._read_frames,"framesWritten":self._write_frames,
                    "resourceSettlementObserved":False}
