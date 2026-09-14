"""Canonical bounded codec for supervisor-owned private process pipes.

Not authentication or encryption. Model text stays a JSON string inside body,
never a transport frame. App Server int64 IDs must stay guest-side or be tagged.
"""
import json
import re
import struct

MAX_FRAME_BYTES = 3 * 1024 * 1024
MAX_PUSH_BYTES = 8 * 1024 * 1024
MAX_PUSH_FRAMES = 32
MAX_DEPTH = 16
MAX_VALUES = 4096
MAX_SAFE_INTEGER = 2**53 - 1
KINDS = frozenset(("start", "ready", "turn", "tool", "tool-result", "answer", "stop", "closed"))
KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z", re.ASCII)
SESSION = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
FIELDS = {"version", "sessionId", "sequence", "kind", "body"}


class PipeError(ValueError):
    def __init__(self): super().__init__("NATIVE_PIPE_REFUSED")


def require(ok):
    if not ok: raise PipeError()


def _validate(value, depth=0, count=None):
    # Depth0 is the root; object keys do not count as JSON values.
    if count is None: count = [0, 0]
    count[0] += 1
    require(depth <= MAX_DEPTH and count[0] <= MAX_VALUES)
    def budget(size):
        count[1] += size
        require(count[1] <= MAX_FRAME_BYTES)
    if value is None or type(value) is bool:
        budget(4 if value is None or value is True else 5); return
    if type(value) is int:
        require(-MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER); budget(len(str(value))); return
    if type(value) is str:
        require(len(value) <= MAX_FRAME_BYTES)
        require(len(value.encode("utf-8", "strict")) <= MAX_FRAME_BYTES)
        budget(len(json.dumps(value, ensure_ascii=False).encode("utf-8", "strict"))); return
    if type(value) is list:
        budget(2 + max(0, len(value)-1))
        for child in value: _validate(child, depth+1, count)
        return
    if type(value) is dict:
        budget(2 + max(0, len(value)-1))
        for key, child in value.items():
            require(type(key) is str and KEY.fullmatch(key) is not None and key not in {"constructor", "prototype", "__proto__"})
            budget(len(key)+3)
            _validate(child, depth+1, count)
        return
    raise PipeError()


def _envelope(frame):
    _validate(frame)
    require(type(frame) is dict and set(frame) == FIELDS)
    require(type(frame["version"]) is int and frame["version"] == 1)
    require(type(frame["sessionId"]) is str and SESSION.fullmatch(frame["sessionId"]) is not None)
    require(type(frame["sequence"]) is int and 1 <= frame["sequence"] <= MAX_SAFE_INTEGER)
    require(type(frame["kind"]) is str and frame["kind"] in KINDS and type(frame["body"]) is dict)


def _canonical(frame):
    _envelope(frame)
    payload = json.dumps(frame, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("utf-8", "strict")
    require(0 < len(payload) <= MAX_FRAME_BYTES)
    return payload


def encode_frame(frame):
    try:
        payload = _canonical(frame)
        return struct.pack(">I", len(payload)) + payload
    except Exception:
        raise PipeError() from None


def _pairs(pairs):
    value = {}
    for key, child in pairs:
        require(key not in value)
        value[key] = child
    return value


def _constant(_): raise PipeError()


def _integer(value):
    # Bound conversion before Python's integer parser sees arbitrary digits.
    require(len(value) <= 17)
    result = int(value)
    require(-MAX_SAFE_INTEGER <= result <= MAX_SAFE_INTEGER)
    return result


def decode_frame(data):
    try:
        require(type(data) is bytes and 4 <= len(data) <= MAX_FRAME_BYTES+4)
        size = struct.unpack(">I", data[:4])[0]
        require(0 < size <= MAX_FRAME_BYTES and len(data) == size+4)
        payload = data[4:]
        value = json.loads(payload.decode("utf-8", "strict"), object_pairs_hook=_pairs,
                           parse_int=_integer, parse_float=_constant, parse_constant=_constant)
        require(_canonical(value) == payload)
        return value
    except Exception:
        raise PipeError() from None


class Framer:
    def __init__(self):
        self._pending = b""
        self._closed = False
        self._poisoned = False

    def push(self, chunk):
        try:
            require(not self._closed and not self._poisoned and type(chunk) is bytes)
            require(len(chunk) + len(self._pending) <= MAX_PUSH_BYTES)
            data = self._pending + chunk
            frames, offset = [], 0
            while len(data)-offset >= 4:
                size = struct.unpack(">I", data[offset:offset+4])[0]
                require(0 < size <= MAX_FRAME_BYTES)
                if len(data)-offset < size+4: break
                require(len(frames) < MAX_PUSH_FRAMES)
                frames.append(decode_frame(data[offset:offset+4+size]))
                offset += size+4
            self._pending = data[offset:]
            require(len(self._pending) <= MAX_FRAME_BYTES+3)
            return frames
        except Exception:
            self._pending = b""; self._poisoned = True
            raise PipeError() from None

    def end(self):
        try:
            require(not self._closed and not self._poisoned and not self._pending)
            self._closed = True
        except Exception:
            self._pending = b""; self._poisoned = True; self._closed = True
            raise PipeError() from None


class SessionCodec:
    def __init__(self, sessionId, sendKinds, receiveKinds):
        try:
            require(type(sessionId) is str and SESSION.fullmatch(sessionId) is not None)
            require(type(sendKinds) in (set, frozenset, list, tuple) and type(receiveKinds) in (set, frozenset, list, tuple))
            require(len(sendKinds) > 0 and len(receiveKinds) > 0)
            require(all(type(kind) is str and kind in KINDS for kind in (*sendKinds, *receiveKinds)))
            require(len(set(sendKinds)) == len(sendKinds) and len(set(receiveKinds)) == len(receiveKinds))
            self._session = sessionId
            self._send_kinds, self._receive_kinds = frozenset(sendKinds), frozenset(receiveKinds)
            self._send, self._receive, self._poisoned = 0, 0, False
        except Exception:
            raise PipeError() from None

    def encode(self, kind, body):
        try:
            require(not self._poisoned and type(kind) is str and kind in self._send_kinds)
            result = encode_frame({"version": 1, "sessionId": self._session, "sequence": self._send+1, "kind": kind, "body": body})
            self._send += 1
            return result
        except Exception:
            self._poisoned = True
            raise PipeError() from None

    def accept(self, frame):
        try:
            require(not self._poisoned)
            # Validate and snapshot so caller mutations cannot change admitted data.
            value = decode_frame(encode_frame(frame))
            require(value["sessionId"] == self._session and value["sequence"] == self._receive+1 and value["kind"] in self._receive_kinds)
            self._receive += 1
            return value
        except Exception:
            self._poisoned = True
            raise PipeError() from None
