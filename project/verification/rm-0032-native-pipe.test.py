import copy
import importlib.util
import json
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location("pipe", Path(__file__).with_name("rm-0032-native-pipe.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SID = "0123456789abcdef0123456789abcdef"


def frame(body=None, **changes):
    return {"version": 1, "sessionId": SID, "sequence": 1, "kind": "turn", "body": {} if body is None else body, **changes}


def raw(text):
    payload = text.encode() if type(text) is str else text
    return struct.pack(">I", len(payload)) + payload


class PipeTests(unittest.TestCase):
    def refused(self, operation):
        with self.assertRaises(m.PipeError) as caught: operation()
        self.assertEqual(str(caught.exception), "NATIVE_PIPE_REFUSED")

    def test_canonical_unicode_keys_order_and_safe_numbers(self):
        value = frame({"z": None, "a": [True, False, m.MAX_SAFE_INTEGER, -m.MAX_SAFE_INTEGER, "Привет 🤝\n\"\\\u2028"]})
        encoded = m.encode_frame(value)
        self.assertEqual(m.decode_frame(encoded), value)
        self.assertTrue(encoded[4:].startswith(b'{"body":{"a":'))
        self.assertIn("Привет".encode(), encoded)
        self.assertEqual(encoded, m.encode_frame(dict(reversed(list(value.items())))))

    def test_reject_float_nan_unsafe_integer_and_non_json_types(self):
        for value in (1.0, float("nan"), float("inf"), 2**53, -(2**53), b"bytes", (1,), {1}, object(), "\ud800"):
            with self.subTest(type=type(value).__name__): self.refused(lambda: m.encode_frame(frame({"value": value})))

    def test_keys_restricted(self):
        for key in ("constructor", "prototype", "__proto__", "_x", "a-b", "а", "a"*65, "a\n", 1):
            self.refused(lambda: m.encode_frame(frame({key: 1})))
        self.assertEqual(m.decode_frame(m.encode_frame(frame({"a"*64: 1, "a_2": 2}))) ["body"]["a_2"], 2)

    def test_envelope_exact_and_scalar_types(self):
        for changes in ({"extra": 1}, {"version": True}, {"version": 2}, {"sessionId": SID.upper()}, {"sessionId": "a"*31},
                        {"sequence": True}, {"sequence": 0}, {"kind": "unknown"}, {"body": []}):
            self.refused(lambda: m.encode_frame(frame(**changes)))
        value = frame(); del value["kind"]; self.refused(lambda: m.encode_frame(value))

    def test_alternate_json_representations_rejected(self):
        canonical = m.encode_frame(frame({"x": 0, "s": "а"}))[4:].decode()
        variants = [canonical+" ", canonical.replace('"x":0', '"x":-0'), canonical.replace('"x":0', '"x":0.0'),
                    canonical.replace('"x":0', '"x":1e0'), canonical.replace('"а"', '"\\u0430"'),
                    canonical.replace('"x":0', '"x":0,"x":0'), json.dumps(frame({"x": 0, "s": "а"}), ensure_ascii=False)]
        for value in variants: self.refused(lambda: m.decode_frame(raw(value)))
        self.refused(lambda: m.decode_frame(raw(b'\xef\xbb\xbf'+canonical.encode())))

    def test_malformed_header_utf8_and_trailing_bytes(self):
        for value in (b"", b"\x00"*4, struct.pack(">I", m.MAX_FRAME_BYTES+1), raw(b"\xff"), m.encode_frame(frame())+b"x"):
            self.refused(lambda: m.decode_frame(value))

    def test_depth_exact_boundary(self):
        body = {}; node = body
        for _ in range(15): node["a"] = {}; node = node["a"]
        # Envelope root0, body1, last nested dict16.
        self.assertEqual(m.decode_frame(m.encode_frame(frame(body))), frame(body))
        node["a"] = None
        self.refused(lambda: m.encode_frame(frame(body)))

    def test_value_count_exact_boundary(self):
        # Root+four envelope scalars+body+list =7, remaining scalar slots4089.
        value = frame({"items": [0]*4089})
        self.assertEqual(m.decode_frame(m.encode_frame(value)), value)
        value["body"]["items"].append(0); self.refused(lambda: m.encode_frame(value))

    def test_size_exact_boundary(self):
        value = frame({"text": ""})
        overhead = len(m.encode_frame(value))-4
        value["body"]["text"] = "a"*(m.MAX_FRAME_BYTES-overhead)
        data = m.encode_frame(value)
        self.assertEqual(len(data), m.MAX_FRAME_BYTES+4)
        self.assertEqual(m.decode_frame(data), value)
        value["body"]["text"] += "a"; self.refused(lambda: m.encode_frame(value))

    def test_every_split_and_concatenation(self):
        data = m.encode_frame(frame({"text": "нейро 🤝"}))
        for split in range(len(data)+1):
            framer = m.Framer()
            self.assertEqual(framer.push(data[:split])+framer.push(data[split:]), [frame({"text": "нейро 🤝"})])
            framer.end()
        framer = m.Framer(); self.assertEqual(len(framer.push(data*32)), 32); framer.end()

    def test_frame_count_per_push_poisoned(self):
        framer = m.Framer(); data = m.encode_frame(frame())
        self.refused(lambda: framer.push(data*33))
        self.refused(lambda: framer.push(data)); self.refused(framer.end)

    def test_pending_plus_input_cap_and_bad_length_poison(self):
        framer = m.Framer(); framer.push(b"\x00")
        self.refused(lambda: framer.push(b"a"*m.MAX_PUSH_BYTES))
        self.refused(lambda: framer.push(b""))
        for size in (0, m.MAX_FRAME_BYTES+1):
            framer = m.Framer(); self.refused(lambda: framer.push(struct.pack(">I", size)))

    def test_partial_end_closed_and_mutable_chunk_refused(self):
        framer = m.Framer(); framer.push(b"\x00\x00")
        self.refused(framer.end); self.refused(lambda: framer.push(b""))
        framer = m.Framer(); framer.end(); self.refused(framer.end)
        self.refused(lambda: framer.push(b""))
        self.refused(lambda: m.Framer().push(bytearray()))

    def test_bidirectional_session_sequence_and_snapshots(self):
        host = m.SessionCodec(SID, ["turn", "stop"], ["answer", "ready"])
        guest = m.SessionCodec(SID, ["answer", "ready"], ["turn", "stop"])
        for index in (1, 2):
            sent = m.decode_frame(host.encode("turn", {"text": "private"}))
            accepted = guest.accept(sent); self.assertEqual(accepted["sequence"], index)
            sent["body"]["text"] = "changed"; self.assertEqual(accepted["body"]["text"], "private")
            self.assertEqual(host.accept(m.decode_frame(guest.encode("answer", {"text": "ok"})))["sequence"], index)

    def test_foreign_duplicate_skipped_direction_and_invalid_send_poison(self):
        for value in (frame(sessionId="f"*32), frame(sequence=2), frame(kind="ready")):
            codec = m.SessionCodec(SID, ["answer"], ["turn"])
            self.refused(lambda: codec.accept(value)); self.refused(lambda: codec.encode("answer", {}))
        codec = m.SessionCodec(SID, ["answer"], ["turn"]); codec.accept(frame())
        self.refused(lambda: codec.accept(frame()))
        codec = m.SessionCodec(SID, ["answer"], ["turn"])
        self.refused(lambda: codec.encode("turn", {})); self.refused(lambda: codec.accept(frame()))

    def test_no_payload_in_failure(self):
        self.refused(lambda: m.decode_frame(raw('{"PRIVATE":"secret"}')))


if __name__ == "__main__": unittest.main()
