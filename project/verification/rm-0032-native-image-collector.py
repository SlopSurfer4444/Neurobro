"""Source-only image lifecycle collector. No model, RPC, files, network or logging.

Caller owns a default-off image policy, native JSON framing and custody, exact
turn completion and transport settlement. Existing text/RPC limits are unchanged.
Schema permits string status; the three statuses below come from auxiliary c147
image-generation implementation, not an installed-schema enum or live proof.
"""
import base64
import binascii
import hashlib
import json
import secrets
import struct

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_BASE64_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3)
IMAGE_FRAME_BYTES = MAX_BASE64_BYTES + 65536
IMAGE_LIFECYCLE_BYTES = 3 * MAX_BASE64_BYTES + 65536
IMAGE_EVIDENCE_COUNT = 32
ARTIFACT_CHUNK_BYTES = 384 * 1024
ARTIFACT_FRAME_BYTES = 768 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SCOPE_KEYS = {"requestRef", "threadId", "turnId"}
ITEM_KEYS = {"id", "type", "status", "result", "failure", "savedPath", "revisedPrompt", "transparentBackground"}


class ImageCollectorError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__("NATIVE_IMAGE_" + code.upper())


def need(condition, code):
    if not condition:
        raise ImageCollectorError(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8", "strict")


def identifier(value):
    try:
        return type(value) is str and 1 <= len(value) <= 256 and not any(ord(ch) <= 32 or ord(ch) == 127 for ch in value) and len(value.encode("utf-8", "strict")) <= 1024
    except UnicodeError:
        return False


def int64(value):
    return type(value) is int and -(2**63) <= value < 2**63


def png_dimensions(data):
    """Container/CRC validation only; no IDAT inflation or visual validity claim."""
    need(len(data) >= 57 and data[:8] == PNG_SIGNATURE, "png")
    offset, count, width, height, color, depth = 8, 0, 0, 0, -1, 0
    palette, saw_data, ended_data, data_bytes = False, False, False, 0
    while offset < len(data):
        count += 1
        need(count <= 4096 and len(data) - offset >= 12, "png")
        length = struct.unpack_from(">I", data, offset)[0]
        need(length <= len(data) - offset - 12, "png")
        end, kind = offset + 12 + length, bytes(data[offset + 4:offset + 8])
        need(all(65 <= ch <= 90 or 97 <= ch <= 122 for ch in kind) and not kind[2] & 32, "png")
        need(binascii.crc32(memoryview(data)[offset + 4:end - 4]) & 0xffffffff == struct.unpack_from(">I", data, end - 4)[0], "png")
        need(count != 1 or kind == b"IHDR", "png")
        if kind == b"IHDR":
            need(count == 1 and length == 13, "png")
            width, height, depth, color, compression, filtering, interlace = struct.unpack_from(">IIBBBBB", data, offset + 8)
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            need(1 <= width <= 8192 and 1 <= height <= 8192 and width * height <= 16 * 1024 * 1024 and depth in depths.get(color, ()) and compression == filtering == 0 and interlace in (0, 1), "png")
        elif kind == b"PLTE":
            need(not palette and not saw_data and color not in (0, 4) and 0 < length <= 768 and length % 3 == 0 and (color != 3 or length // 3 <= 2**depth), "png")
            palette = True
        elif kind == b"IDAT":
            need(not ended_data and (color != 3 or palette), "png")
            saw_data, data_bytes = True, data_bytes + length
        elif kind == b"IEND":
            need(length == 0 and saw_data and data_bytes > 0 and end == len(data), "png")
            return width, height
        else:
            need(kind[0] & 32 and kind not in (b"acTL", b"fcTL", b"fdAT"), "png")
        if saw_data and kind != b"IDAT":
            ended_data = True
        offset = end
    raise ImageCollectorError("png")


def decode_png(result):
    need(type(result) is str and result and len(result) % 4 == 0, "base64")
    need(len(result) <= MAX_BASE64_BYTES, "size")
    padding = 2 if result.endswith("==") else 1 if result.endswith("=") else 0
    need(len(result) // 4 * 3 - padding <= MAX_IMAGE_BYTES, "size")
    try:
        data = bytearray(base64.b64decode(result, validate=True))
    except (ValueError, binascii.Error):
        raise ImageCollectorError("base64") from None
    try:
        need(base64.b64encode(data).decode("ascii") == result, "base64")
        dimensions = png_dimensions(data)
        return data, dimensions
    except BaseException:
        data[:] = b"\0" * len(data)
        raise


class NativeImageCollector:
    def __init__(self, scope):
        need(type(scope) is dict and set(scope) == SCOPE_KEYS and all(identifier(scope[key]) for key in SCOPE_KEYS), "scope")
        self._scope = {key: scope[key] for key in ("requestRef", "threadId", "turnId")}
        self._item = None
        self._started = self._completed = None
        self._terminal = self._failure = None
        self._bytes = self._dimensions = self._digest = self._ref = None
        self._finished = self._closed = self._revoked = False
        self._count = self._wire = 0

    def _open(self):
        need(not self._closed and not self._revoked, "revoked")

    def _revoke(self):
        self._revoked = True
        if self._bytes is not None:
            self._bytes[:] = b"\0" * len(self._bytes)
        self._bytes = None

    def close(self):
        self._revoke()
        self._closed = True

    def _bound(self, thread_id, turn_id):
        need(type(thread_id) is str and thread_id == self._scope["threadId"] and type(turn_id) is str and turn_id == self._scope["turnId"], "correlation")

    def _validate_item(self, item):
        need(type(item) is dict and {"id", "type", "status", "result"} <= set(item) <= ITEM_KEYS and item["type"] == "imageGeneration" and identifier(item["id"]), "item")
        need(item["status"] in ("in_progress", "completed", "failed") and type(item["result"]) is str, "status")
        # Bound strings before serializing; do not read any savedPath file/URL.
        need(len(item["result"]) <= MAX_BASE64_BYTES, "size")
        for key, cap in (("savedPath", 4096), ("revisedPrompt", 16384)):
            value = item.get(key)
            need(value is None or type(value) is str and len(value) <= cap and len(value.encode("utf-8", "strict")) <= cap, "item")
        need(item.get("transparentBackground") is None or type(item["transparentBackground"]) is bool, "item")
        failure = item.get("failure")
        if failure is not None:
            need(type(failure) is dict and {"type", "limitId"} <= set(failure) <= {"type", "limitId", "resetsAt"} and failure["type"] == "usageLimitExceeded" and identifier(failure["limitId"]) and (failure.get("resetsAt") is None or int64(failure["resetsAt"])), "failure")
        need(item["status"] == "failed" or failure is None, "failure")
        need(item["status"] == "completed" or item["result"] == "", "status")
        need(self._item is None or self._item == item["id"], "multiple-images")
        size = len(encoded(item))
        need(size <= IMAGE_FRAME_BYTES, "budget")
        self._count += 1; self._wire += size
        need(self._count <= IMAGE_EVIDENCE_COUNT and self._wire <= IMAGE_LIFECYCLE_BYTES, "budget")
        self._item = item["id"]
        return failure

    def _accept(self, item):
        failure = self._validate_item(item)
        status = item["status"]
        if status == "in_progress":
            return
        need(self._terminal is None or self._terminal == status, "conflict")
        if self._failure is not None and failure is not None:
            need(self._failure == failure, "conflict")
        if status == "failed":
            self._terminal = status
            if failure is not None:
                self._failure = dict(failure)
            return
        data = None
        try:
            data, dimensions = decode_png(item["result"])
            digest = hashlib.sha256(data).hexdigest()
            if self._bytes is not None:
                need(digest == self._digest and data == self._bytes, "conflict")
            else:
                self._bytes, data = data, None
                self._dimensions, self._digest = dimensions, digest
                self._ref = "img_" + secrets.token_hex(24)
            self._terminal = status
        finally:
            if data is not None:
                data[:] = b"\0" * len(data)

    def observe_notification(self, frame):
        """Exact normalized item notification; jsonrpc/emittedAtMs were handled by RPC.
        Only image notifications belong here. Root routes ordinary events as before."""
        self._open()
        try:
            need(not self._finished and type(frame) is dict and set(frame) == {"method", "params"}, "envelope")
            method, params = frame["method"], frame["params"]
            need(method in ("item/started", "item/completed"), "envelope")
            stamp = "startedAtMs" if method == "item/started" else "completedAtMs"
            need(type(params) is dict and set(params) == {"threadId", "turnId", "item", stamp} and int64(params[stamp]), "envelope")
            self._bound(params["threadId"], params["turnId"])
            item = params["item"]
            self._accept(item)
            if method == "item/started":
                need(item["status"] == "in_progress" and self._completed is None and (self._started is None or self._started == params[stamp]), "lifecycle")
                self._started = params[stamp]
            else:
                need(item["status"] in ("completed", "failed") and self._started is not None and params[stamp] >= self._started and (self._completed is None or self._completed == params[stamp]), "lifecycle")
                self._completed = params[stamp]
        except Exception as error:
            self._revoke()
            if isinstance(error, ImageCollectorError): raise
            raise ImageCollectorError("shape") from None

    def observe_snapshot(self, item, *, thread_id, turn_id):
        """A validated current-turn full items snapshot can precede queued lifecycle
        notifications (e.g. turn/start ACK). It is evidence, not lifecycle admission."""
        self._open()
        try:
            need(not self._finished, "lifecycle")
            self._bound(thread_id, turn_id)
            self._accept(item)
        except Exception as error:
            self._revoke()
            if isinstance(error, ImageCollectorError): raise
            raise ImageCollectorError("shape") from None

    def finish_turn(self, *, thread_id, turn_id, status):
        """Caller invokes only after its existing exact native turn terminal checks.
        Export remains unavailable before successful turn completion + both events."""
        self._open()
        try:
            need(not self._finished, "lifecycle")
            self._bound(thread_id, turn_id)
            need(status == "completed", "turn-failed")
            if self._item is not None:
                need(self._started is not None and self._completed is not None and self._terminal in ("completed", "failed"), "missing-terminal")
            self._finished = True
            return self.metadata()
        except Exception as error:
            self._revoke()
            if isinstance(error, ImageCollectorError): raise
            raise ImageCollectorError("shape") from None

    def metadata(self):
        outcome = "revoked" if self._revoked else "not-requested" if self._item is None else "pending" if not self._finished else self._terminal
        return {"outcome": outcome, "started": self._started is not None, "completed": self._completed is not None,
                "evidenceCount": self._count, "imageLifecycleBytes": self._wire,
                "failureCode": "usageLimitExceeded" if self._failure else "generationFailed" if self._terminal == "failed" else "none"}

    def artifact_record(self):
        self._open()
        need(self._finished and self._terminal == "completed" and self._bytes is not None, "not-ready")
        return {"schema": "neurobro-generated-image-artifact-v1", "ref": self._ref,
                "origin": {**self._scope, "itemId": self._item}, "mimeType": "image/png",
                "byteLength": len(self._bytes), "sha256": self._digest,
                "width": self._dimensions[0], "height": self._dimensions[1]}

    def artifact_frames(self):
        """Typed private artifact records; caller wraps its owned transport envelope.
        Write/ACK one record at a time, not an unbounded array or model text. A
        receiver must verify all chunks + digest/end before artifact admission."""
        artifact = self.artifact_record()
        yield {"kind": "imageBegin", "artifact": artifact}
        count = 0
        for offset in range(0, artifact["byteLength"], ARTIFACT_CHUNK_BYTES):
            self._open()
            frame = {"kind": "imageChunk", "artifactRef": artifact["ref"], "sequence": count,
                     "dataBase64": base64.b64encode(memoryview(self._bytes)[offset:offset + ARTIFACT_CHUNK_BYTES]).decode("ascii")}
            need(len(encoded(frame)) <= ARTIFACT_FRAME_BYTES, "budget")
            yield frame
            count += 1
        self._open()
        yield {"kind": "imageEnd", "artifactRef": artifact["ref"], "chunkCount": count,
               "byteLength": artifact["byteLength"], "sha256": artifact["sha256"]}
