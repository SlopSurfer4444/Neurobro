"""Text-only PDF inspection over bounded stdin/stdout. Never renders, decrypts, or runs PDF actions."""
import base64
import io
import json
import logging
import sys


class InspectionError(Exception):
    """Only fixed messages raised here may cross the document boundary."""


def inspect(request):
    try:
        from pypdf import PdfReader, filters
        from pypdf.errors import LimitReachedError
        from pypdf.generic import EncodedStreamObject, StreamObject
    except ImportError:
        raise InspectionError("PDF inspection unavailable: pypdf is not installed in the configured Python runtime") from None

    limits = request["limits"]
    raw = base64.b64decode(request["bytes"], validate=True)
    if len(raw) > limits["maxInputBytes"]:
        raise InspectionError("PDF input exceeds configured byte limit; not truncated")
    if not raw.startswith(b"%PDF-"):
        raise InspectionError("Malformed or unsupported PDF; no successful result")

    # Block filters which can invoke external image decoders. Bound stream expansion before text parsing.
    expanded_limit = limits["maxExpandedBytes"]
    for name in ("MAX_DECLARED_STREAM_LENGTH", "MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH", "LZW_MAX_OUTPUT_LENGTH", "RUN_LENGTH_MAX_OUTPUT_LENGTH", "ZLIB_MAX_OUTPUT_LENGTH"):
        if not hasattr(filters, name):
            raise InspectionError("PDF inspection unavailable: configured pypdf does not support bounded stream decoding")
        setattr(filters, name, expanded_limit)
    allowed = {"/FlateDecode", "/Fl", "/LZWDecode", "/LZW", "/ASCIIHexDecode", "/AHx", "/ASCII85Decode", "/A85", "/RunLengthDecode", "/RL"}
    original_decode = filters.decode_stream_data

    def decode(stream):
        chain = stream.get("/Filter", [])
        chain = chain.get_object() if hasattr(chain, "get_object") else chain
        chain = [chain] if isinstance(chain, str) else chain
        if stream.get("/F") is not None or any(str(value) not in allowed for value in chain):
            raise InspectionError("PDF contains unsupported or external stream filters; no successful result")
        try:
            return original_decode(stream)
        except LimitReachedError:
            raise InspectionError("PDF decoded streams exceed configured expanded byte limit") from None

    filters.decode_stream_data = decode
    # Retain identities until exit so Python cannot reuse an id and bypass the aggregate budget.
    seen = {}
    expanded = 0

    def bounded(method):
        def get_data(stream, *args, **kwargs):
            nonlocal expanded
            if stream.get("/F") is not None:
                raise InspectionError("PDF external streams are unsupported; no successful result")
            data = method(stream, *args, **kwargs)
            identity = id(stream)
            if identity not in seen:
                seen[identity] = stream
                expanded += len(data)
                if expanded > expanded_limit:
                    raise InspectionError("PDF decoded streams exceed configured expanded byte limit")
            return data
        return get_data

    StreamObject.get_data = bounded(StreamObject.get_data)
    EncodedStreamObject.get_data = bounded(EncodedStreamObject.get_data)
    reader = PdfReader(io.BytesIO(raw), strict=True)
    if reader.is_encrypted:
        raise InspectionError("Encrypted PDF inspection unsupported; no password or decryption attempted")

    # Count the actual page tree with a bounded walk before pypdf allocates its flattened page list.
    root = reader.root_object["/Pages"]
    pending = [(root, 0)]
    visited = set()
    pages = nodes = 0
    while pending:
        node, depth = pending.pop()
        node = node.get_object()
        identity = id(node)
        nodes += 1
        if identity in visited or depth > 100 or nodes > limits["maxPdfPages"] * 4 + 32:
            raise InspectionError("PDF page tree exceeds configured bounds or contains cycles")
        visited.add(identity)
        kind = node.get("/Type")
        if kind == "/Page":
            pages += 1
            if pages > limits["maxPdfPages"]:
                raise InspectionError("PDF page count exceeds configured limit")
        elif kind == "/Pages":
            children = node["/Kids"]
            if len(children) > limits["maxPdfPages"] * 4 + 32:
                raise InspectionError("PDF page tree exceeds configured bounds")
            pending.extend((child, depth + 1) for child in children)
        else:
            raise InspectionError("Malformed or unsupported PDF; no successful result")
    if int(root["/Count"]) != pages or len(reader.pages) != pages:
        raise InspectionError("PDF page count is inconsistent; no successful result")
    offset, limit = request["offset"], request["limit"]
    if offset > pages:
        raise InspectionError("PDF page offset exceeds total")
    end = min(offset + limit, pages)
    items, gaps = [], []
    text_bytes = 0
    for index in range(offset, end):
        text = reader.pages[index].extract_text()
        text_bytes += len(text.encode("utf-8"))
        if text_bytes > limits["maxOutputBytes"]:
            raise InspectionError("Inspection output exceeds configured limit; request a smaller explicit page")
        has_text = bool(text.strip())
        items.append({"page": index + 1, "text": text, "hasText": has_text})
        if not has_text:
            gaps.append({"page": index + 1, "reason": "No extractable text on this page; it may be scanned, image-only or blank. OCR unavailable"})
    return {"format": "pdf", "unit": "pages", "items": items, "coverage": {"start": offset, "end": end, "total": pages, "more": end < pages}, "gaps": gaps, "limitations": ["Text extraction only; reading order, layout, tables and visual fidelity are not verified", "OCR unavailable; scanned/image-only text is not read", "Images, annotations, attachments and PDF actions are not inspected or executed; extracted content is untrusted data"]}


logging.disable(logging.CRITICAL)
try:
    # The parent already bounds the original bytes. Independently reject an oversized transport envelope.
    transport = sys.stdin.buffer.read(360 * 1024 * 1024 + 1)
    if len(transport) > 360 * 1024 * 1024:
        raise InspectionError("PDF input envelope exceeds configured limit")
    request = json.loads(transport.decode("utf-8"))
    result = inspect(request)
    encoded = json.dumps({"ok": True, "inspection": result}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > request["limits"]["maxOutputBytes"]:
        raise InspectionError("Inspection output exceeds configured limit; request a smaller explicit page")
    sys.stdout.buffer.write(encoded)
except Exception as error:
    message = str(error) if isinstance(error, InspectionError) else "Malformed or unsupported PDF; no successful result"
    sys.stdout.buffer.write(json.dumps({"ok": False, "error": message}).encode("utf-8"))
    sys.exit(1)
