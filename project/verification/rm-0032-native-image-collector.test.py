import base64
import binascii
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("rm-0032-native-image-collector.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")
SCOPE = {"requestRef": "selected-request", "threadId": "thread-native", "turnId": "turn-native"}


def item(status="completed", data=PNG, **extra):
    return {"id": "image-native", "type": "imageGeneration", "status": status,
            "result": base64.b64encode(data).decode() if status == "completed" else "", **extra}


def notification(kind, value=None, timestamp=None, **extra):
    started = kind == "started"
    return {"method": "item/" + kind, "params": {"threadId": SCOPE["threadId"], "turnId": SCOPE["turnId"],
        "item": item("in_progress" if started else "completed") if value is None else value,
        "startedAtMs" if started else "completedAtMs": (100 if started else 200) if timestamp is None else timestamp, **extra}}


def ready(value=None):
    c = m.NativeImageCollector(SCOPE)
    c.observe_notification(notification("started"))
    c.observe_notification(notification("completed", value))
    c.finish_turn(thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"], status="completed")
    return c


def chunk(kind, data):
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(">I", binascii.crc32(payload) & 0xffffffff)


def png(header=PNG[16:29], middle=None):
    if middle is None:
        middle = chunk(b"IDAT", PNG[41:54])
    return PNG[:8] + chunk(b"IHDR", header) + middle + chunk(b"IEND", b"")


class CollectorTests(unittest.TestCase):
    def test_exact_lifecycle_exports_png_origin_and_private_chunk_protocol(self):
        c = ready(item(savedPath="/must-not-open/image.png", revisedPrompt="private prompt"))
        record = c.artifact_record()
        self.assertEqual(record["origin"], {**SCOPE, "itemId": "image-native"})
        self.assertEqual(record["mimeType"], "image/png")
        self.assertEqual((record["width"], record["height"]), (1, 1))
        self.assertEqual(record["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertNotIn("private", json.dumps(record))
        frames = list(c.artifact_frames())
        self.assertEqual([row["kind"] for row in frames], ["imageBegin", "imageChunk", "imageEnd"])
        self.assertEqual(base64.b64decode(frames[1]["dataBase64"]), PNG)
        self.assertEqual(frames[-1]["chunkCount"], 1)
        self.assertEqual(frames[-1]["sha256"], record["sha256"])
        record["origin"]["threadId"] = "mutated"
        self.assertEqual(c.artifact_record()["origin"]["threadId"], SCOPE["threadId"])
        self.assertNotIn(PNG.hex(), json.dumps(c.metadata()))

    def test_started_status_is_source_in_progress_not_dynamic_tool_inProgress(self):
        c = m.NativeImageCollector(SCOPE)
        with self.assertRaisesRegex(m.ImageCollectorError, "STATUS"):
            c.observe_notification(notification("started", item("inProgress")))
        self.assertEqual(c.metadata()["outcome"], "revoked")

    def test_repeated_snapshot_and_completion_do_not_duplicate_or_rebind(self):
        c = m.NativeImageCollector(SCOPE)
        c.observe_notification(notification("started"))
        c.observe_notification(notification("completed"))
        c.observe_snapshot(item(savedPath="irrelevant", transparentBackground=True), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        c.observe_notification(notification("completed"))
        c.finish_turn(thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"], status="completed")
        self.assertEqual(list(c.artifact_frames()), list(c.artifact_frames()))

    def test_terminal_ack_snapshot_before_queued_start_event_is_provisional(self):
        c = m.NativeImageCollector(SCOPE)
        c.observe_snapshot(item(), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        with self.assertRaisesRegex(m.ImageCollectorError, "NOT-READY"):
            c.artifact_record()
        c.observe_notification(notification("started"))
        c.observe_notification(notification("completed"))
        c.finish_turn(thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"], status="completed")
        self.assertEqual(c.metadata()["outcome"], "completed")

    def test_snapshot_without_both_lifecycle_notifications_cannot_export(self):
        for start in (False, True):
            c = m.NativeImageCollector(SCOPE)
            if start:
                c.observe_notification(notification("started"))
            c.observe_snapshot(item(), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
            with self.assertRaisesRegex(m.ImageCollectorError, "MISSING-TERMINAL"):
                c.finish_turn(thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"], status="completed")
            with self.assertRaises(m.ImageCollectorError):
                c.artifact_record()

    def test_item_completion_before_started_notification_refuses(self):
        c = m.NativeImageCollector(SCOPE)
        with self.assertRaisesRegex(m.ImageCollectorError, "LIFECYCLE"):
            c.observe_notification(notification("completed"))

    def test_same_item_conflicting_png_revokes_pending_artifact(self):
        c = m.NativeImageCollector(SCOPE)
        c.observe_notification(notification("started"))
        c.observe_notification(notification("completed"))
        different = png(middle=chunk(b"tEXt", b"label\0different") + chunk(b"IDAT", PNG[41:54]))
        with self.assertRaisesRegex(m.ImageCollectorError, "CONFLICT"):
            c.observe_snapshot(item(data=different), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        self.assertEqual(c.metadata()["outcome"], "revoked")
        self.assertIsNone(c._bytes)

    def test_second_image_and_foreign_request_thread_turn_refuse(self):
        for field in ("threadId", "turnId"):
            c = m.NativeImageCollector(SCOPE)
            frame = notification("started"); frame["params"][field] = "foreign"
            with self.assertRaisesRegex(m.ImageCollectorError, "CORRELATION"):
                c.observe_notification(frame)
        c = m.NativeImageCollector(SCOPE); c.observe_notification(notification("started"))
        with self.assertRaisesRegex(m.ImageCollectorError, "MULTIPLE-IMAGES"):
            c.observe_snapshot(item(id="second"), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        scope = dict(SCOPE); other = m.NativeImageCollector(scope); scope["requestRef"] = "changed"
        self.assertEqual(other._scope["requestRef"], SCOPE["requestRef"])

    def test_failure_is_terminal_but_not_an_exportable_image(self):
        for failure in (None, {"type": "usageLimitExceeded", "limitId": "image-limit", "resetsAt": 2**63 - 1}):
            c = ready(item("failed", failure=failure))
            self.assertEqual(c.metadata()["outcome"], "failed")
            self.assertEqual(c.metadata()["failureCode"], "generationFailed" if failure is None else "usageLimitExceeded")
            with self.assertRaisesRegex(m.ImageCollectorError, "NOT-READY"):
                c.artifact_record()

    def test_failed_turn_revokes_a_completed_image_and_never_exports(self):
        for status in ("failed", "interrupted", "inProgress"):
            c = m.NativeImageCollector(SCOPE); c.observe_notification(notification("started")); c.observe_notification(notification("completed"))
            with self.assertRaisesRegex(m.ImageCollectorError, "TURN-FAILED"):
                c.finish_turn(thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"], status=status)
            self.assertIsNone(c._bytes)

    def test_failed_result_and_conflicting_terminal_status_refuse(self):
        bad = item("failed"); bad["result"] = base64.b64encode(PNG).decode()
        c = m.NativeImageCollector(SCOPE); c.observe_notification(notification("started"))
        with self.assertRaisesRegex(m.ImageCollectorError, "STATUS"):
            c.observe_notification(notification("completed", bad))
        c = m.NativeImageCollector(SCOPE); c.observe_notification(notification("started")); c.observe_notification(notification("completed"))
        with self.assertRaisesRegex(m.ImageCollectorError, "CONFLICT"):
            c.observe_snapshot(item("failed"), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])

    def test_strict_envelope_and_exact_int64_timestamps(self):
        for value in (True, 1.5, "100", 2**63):
            c = m.NativeImageCollector(SCOPE)
            with self.assertRaisesRegex(m.ImageCollectorError, "ENVELOPE"):
                c.observe_notification(notification("started", timestamp=value))
        c = m.NativeImageCollector(SCOPE); c.observe_notification(notification("started", timestamp=201))
        with self.assertRaisesRegex(m.ImageCollectorError, "LIFECYCLE"):
            c.observe_notification(notification("completed", timestamp=200))
        c = m.NativeImageCollector(SCOPE); frame = notification("started"); frame["id"] = "server-request"
        with self.assertRaisesRegex(m.ImageCollectorError, "ENVELOPE"):
            c.observe_notification(frame)

    def test_invalid_failure_shape_and_wrong_type_do_not_become_success(self):
        for failure in ({"type": "other", "limitId": "x"}, {"type": "usageLimitExceeded", "limitId": "x", "resetsAt": True}, {"type": "usageLimitExceeded", "limitId": "x", "extra": True}):
            with self.assertRaisesRegex(m.ImageCollectorError, "FAILURE"):
                ready(item("failed", failure=failure))
        with self.assertRaises(m.ImageCollectorError):
            ready(item(type="agentMessage"))

    def test_paths_urls_noncanonical_base64_are_never_read_or_downloaded(self):
        for value in ("/var/lib/auth.json", "https://example.test/a.png", "data:image/png;base64," + base64.b64encode(PNG).decode(), base64.b64encode(PNG).decode() + "\n", "AAAA====", "AAAAA==="):
            with self.assertRaises(m.ImageCollectorError):
                ready({**item(), "result": value})

    def test_crc_truncation_and_structural_errors_refuse(self):
        corrupted = bytearray(PNG); corrupted[45] ^= 1
        for data in (corrupted, PNG[:-1], PNG + b"\0", PNG[:-12], png(middle=chunk(b"IDAT", b"")), png(middle=chunk(b"acTL", b"x") + chunk(b"IDAT", PNG[41:54]))):
            with self.assertRaisesRegex(m.ImageCollectorError, "PNG"):
                ready(item(data=data))

    def test_exact_maximum_png_fits_image_profile_and_chunked_private_frames(self):
        padding = m.MAX_IMAGE_BYTES - len(PNG) - 12
        data = png(middle=chunk(b"tEXt", b"A" * padding) + chunk(b"IDAT", PNG[41:54]))
        self.assertEqual(len(data), m.MAX_IMAGE_BYTES)
        c = ready(item(data=data)); frames = list(c.artifact_frames())
        rebuilt = b"".join(base64.b64decode(frame["dataBase64"], validate=True) for frame in frames if frame["kind"] == "imageChunk")
        self.assertEqual(rebuilt, data)
        self.assertEqual(frames[-1]["chunkCount"], 22)
        self.assertTrue(all(len(m.encoded(frame)) <= m.ARTIFACT_FRAME_BYTES for frame in frames))
        with self.assertRaisesRegex(m.ImageCollectorError, "SIZE"):
            ready(item(data=data + b"x"))

    def test_lifecycle_byte_and_count_budgets_do_not_widen_text_budget(self):
        c = m.NativeImageCollector(SCOPE)
        for _ in range(m.IMAGE_EVIDENCE_COUNT):
            c.observe_snapshot(item("in_progress"), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        with self.assertRaisesRegex(m.ImageCollectorError, "BUDGET"):
            c.observe_snapshot(item("in_progress"), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        data = png(middle=chunk(b"tEXt", b"A" * (m.MAX_IMAGE_BYTES - len(PNG) - 12)) + chunk(b"IDAT", PNG[41:54]))
        c = m.NativeImageCollector(SCOPE)
        for _ in range(3):
            c.observe_snapshot(item(data=data), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])
        with self.assertRaisesRegex(m.ImageCollectorError, "BUDGET"):
            c.observe_snapshot(item(data=data), thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"])

    def test_invalid_scope_is_a_fixed_refusal_not_a_unicode_exception(self):
        for value in ("", "contains space", "\ud800", 123):
            with self.assertRaisesRegex(m.ImageCollectorError, "SCOPE"):
                m.NativeImageCollector({**SCOPE, "requestRef": value})

    def test_close_mid_chunk_stream_never_emits_a_successful_end_record(self):
        c = ready(); frames = c.artifact_frames(); self.assertEqual(next(frames)["kind"], "imageBegin")
        c.close()
        with self.assertRaisesRegex(m.ImageCollectorError, "REVOKED"):
            next(frames)
        c.close()
        with self.assertRaises(m.ImageCollectorError):
            c.artifact_record()

    def test_no_image_turn_is_not_reported_as_generated(self):
        c = m.NativeImageCollector(SCOPE)
        self.assertEqual(c.finish_turn(thread_id=SCOPE["threadId"], turn_id=SCOPE["turnId"], status="completed")["outcome"], "not-requested")
        with self.assertRaisesRegex(m.ImageCollectorError, "NOT-READY"):
            c.artifact_record()


if __name__ == "__main__":
    unittest.main(verbosity=2)
