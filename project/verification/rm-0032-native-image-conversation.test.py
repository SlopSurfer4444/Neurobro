"""Actual base + collector + optional subclass, fake RPC only. No live calls."""
import base64
import binascii
import copy
import importlib.util
import json
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value
fixtures = load("fixtures", "rm-0032-native-conversation.test.py")
n = fixtures.m
c = load("collector", "rm-0032-native-image-collector.py")
w = load("wrapper", "rm-0032-native-image-conversation.py")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")

def chunk(kind, data):
    content = kind + data
    return struct.pack(">I", len(data)) + content + struct.pack(">I", binascii.crc32(content) & 0xffffffff)

def large_png(size=300000):
    return PNG[:-12] + chunk(b"tEXt", b"fixture\0" + b"x" * size) + PNG[-12:]

def image(status="completed", data=PNG, **fields):
    return {"id": "image-1", "type": "imageGeneration", "status": status,
            "result": base64.b64encode(data).decode() if status == "completed" else "", **fields}

def event(turn, completed=False, item=None):
    method, stamp, number = ("item/completed", "completedAtMs", 2) if completed else ("item/started", "startedAtMs", 1)
    return {"method": method, "params": {"threadId": "thread-1", "turnId": turn, stamp: number,
            "item": item if item is not None else image("completed" if completed else "in_progress")}}

def plan(turn, data=PNG):
    return [event(turn), event(turn, True, image(data=data)), fixtures.completed(turn, "Caption only", [image(data=data), fixtures.message(turn, "Caption only")])]

def engine(rpc=None, **kwargs):
    return w.create_native_image_conversation(n, c, fixtures.SOURCE, request_ref="request-image-1", profile=fixtures.PROFILE, cwd=fixtures.CWD,
        tool_spec=copy.deepcopy(fixtures.SPEC), instructions="Generate exactly one image; caption separately; do not claim Telegram delivery.",
        rpc=rpc or fixtures.Rpc(plan), tool=lambda *args: copy.deepcopy(fixtures.RESULT), **kwargs)

class ImageTests(unittest.TestCase):
    def test_real_png_caption_metadata_and_private_artifact_export(self):
        e = engine(); result = e.run("Generate an image")
        self.assertEqual(result["metadata"]["code"], "OK"); self.assertEqual(result["answer"], "Caption only")
        self.assertTrue(result["imageMetadata"]["exportReady"])
        artifact = e.image_artifact(); self.assertEqual(artifact["byteLength"], len(PNG))
        self.assertEqual(artifact["origin"], {"requestRef": "request-image-1", "threadId": "thread-1", "turnId": "turn-1", "itemId": "image-1"})
        frames = list(e.image_frames()); self.assertEqual([f["kind"] for f in frames], ["imageBegin", "imageChunk", "imageEnd"])
        self.assertEqual(base64.b64decode(frames[1]["dataBase64"]), PNG)
        self.assertNotIn(base64.b64encode(PNG).decode(), json.dumps(result))
        self.assertNotIn("delivery", json.dumps(result["imageMetadata"]))

    def test_raw_large_result_has_separate_budget_with_default_ordinary_cap(self):
        data = large_png(); e = engine(fixtures.Rpc(lambda turn: plan(turn, data))); result = e.run("image")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertGreater(result["imageMetadata"]["imageLifecycleBytes"], n.EVENT_BYTES_CAP)
        self.assertLess(result["metadata"]["eventBytes"], n.EVENT_BYTES_CAP)
        self.assertEqual(e.image_artifact()["byteLength"], len(data))
        self.assertEqual(n.EVENT_BYTES_CAP, 262144)

    def test_completed_image_snapshot_in_ack_before_queued_started_and_completed(self):
        class AckRpc(fixtures.Rpc):
            def exchange(self, method, params, timeout):
                result, error = super().exchange(method, params, timeout)
                if method == "turn/start": result["turn"]["items"] = [image(data=large_png())]
                return result, error
        rpc = AckRpc(lambda turn: plan(turn, large_png()))
        e = engine(rpc); result = e.run("image")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(result["imageMetadata"]["evidenceCount"], 4)
        self.assertEqual([x[0] for x in rpc.calls], ["thread/start", "turn/start"])

    def test_duplicate_completed_snapshot_is_idempotent(self):
        def duplicate(turn):
            events = plan(turn)
            events.insert(2, copy.deepcopy(events[1]))
            return events
        e = engine(fixtures.Rpc(duplicate)); self.assertEqual(e.run("x")["metadata"]["code"], "OK")
        self.assertEqual(e.image_artifact()["byteLength"], len(PNG))

    def test_nonimage_oversize_and_arbitrary_envelope_extras_stay_ordinary(self):
        for where in ("ordinary", "extra"):
            def oversized(turn):
                if where == "ordinary": return [{"method":"item/reasoning/textDelta", "params":{"threadId":"thread-1", "turnId":turn, "delta":"x"*262145}}]
                frame = event(turn, True); frame["untrustedExtra"] = "x" * 262145
                return [event(turn), frame]
            e = engine(fixtures.Rpc(oversized)); result = e.run("x")
            self.assertNotEqual(result["metadata"]["code"], "OK"); self.assertFalse(result["imageMetadata"]["exportReady"])
            with self.assertRaises(Exception): e.image_artifact()

    def test_oversized_unknown_field_inside_turn_envelope_is_not_stripped(self):
        def extra(turn):
            events = plan(turn, large_png()); events[-1]["params"]["turn"]["unknownField"] = "x" * 262145
            return events
        result = engine(fixtures.Rpc(extra)).run("x")
        self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        self.assertFalse(result["imageMetadata"]["exportReady"])

    def test_foreign_thread_turn_and_item_refuse(self):
        for field in ("threadId", "turnId", "itemId"):
            def wrong(turn):
                events = plan(turn)
                if field == "itemId": events[1]["params"]["item"]["id"] = "foreign-image"
                else: events[1]["params"][field] = "foreign-id"
                return events
            e = engine(fixtures.Rpc(wrong)); result = e.run("x")
            self.assertNotEqual(result["metadata"]["code"], "OK")
            self.assertTrue(result["metadata"]["sessionPoisoned"])
            with self.assertRaises(Exception): e.image_artifact()

    def test_failed_turn_revokes_collected_bytes(self):
        def failed(turn):
            events = plan(turn); events[-1]["params"]["turn"]["status"] = "failed"
            return events
        e = engine(fixtures.Rpc(failed)); result = e.run("x")
        self.assertEqual(result["metadata"]["code"], "TURN_REFUSED")
        self.assertEqual(result["imageMetadata"]["outcome"], "revoked")
        self.assertIsNone(e._images._bytes)

    def test_failed_image_or_no_image_cannot_pass_as_generated(self):
        failed = lambda turn: [event(turn), event(turn, True, image("failed")), fixtures.completed(turn)]
        for p in (failed, lambda turn:[fixtures.completed(turn)]):
            e = engine(fixtures.Rpc(p)); result = e.run("x")
            self.assertEqual(result["metadata"]["code"], "ANSWER_REFUSED")
            self.assertEqual(result["imageMetadata"]["failureSite"], "image-required")
            with self.assertRaises(Exception): e.image_artifact()

    def test_missing_started_or_completed_notifications_never_export(self):
        for index in (0, 1):
            def missing(turn):
                events = plan(turn); del events[index]; return events
            e = engine(fixtures.Rpc(missing)); result = e.run("x")
            self.assertFalse(result["imageMetadata"]["exportReady"])
            with self.assertRaises(Exception): list(e.image_frames())

    def test_builtin_image_does_not_allow_other_tool_or_request(self):
        def other(turn):
            events = plan(turn); events.insert(1, event(turn, True, {"id":"shell-1", "type":"commandExecution", "command":"private"})); return events
        result = engine(fixtures.Rpc(other)).run("x")
        self.assertEqual(result["metadata"]["code"], "TOOL_EVENT_REFUSED")
        def foreign_request(turn):
            r = fixtures.request(turn); r["params"]["tool"] = "image_generation"; return [r]
        result = engine(fixtures.Rpc(foreign_request)).run("x")
        self.assertEqual(result["metadata"]["code"], "TOOL_REFUSED")

    def test_existing_history_tool_still_has_exact_dispatch_and_terminal_correlation(self):
        rpc = fixtures.Rpc(lambda turn: [fixtures.request(turn), *plan(turn)])
        result = engine(rpc).run("x")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(result["metadata"]["toolCalls"], 1)
        self.assertEqual(len(rpc.responses), 1)

    def test_saved_path_never_read_or_exported(self):
        def paths(turn):
            events = plan(turn)
            for f in events:
                if "item" in f["params"]: f["params"]["item"]["savedPath"] = "/private/nonexistent.png"
            return events
        e = engine(fixtures.Rpc(paths)); result = e.run("x")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertNotIn("private", json.dumps(result) + json.dumps(e.image_artifact()))

    def test_export_before_completion_and_after_close_refused(self):
        e = engine()
        with self.assertRaises(Exception): e.image_artifact()
        self.assertEqual(e.run("x")["metadata"]["code"], "OK")
        frames = e.image_frames(); next(frames); e.close()
        with self.assertRaises(Exception): next(frames)
        with self.assertRaises(Exception): e.image_artifact()
        self.assertIsNone(e._images._bytes)

    def test_exactly_one_admitted_run_no_retry_or_duplicate_generation(self):
        rpc = fixtures.Rpc(plan); e = engine(rpc)
        self.assertEqual(e.run("x")["metadata"]["code"], "OK")
        self.assertEqual(e.run("again")["metadata"]["code"], "SESSION_LIMIT")
        self.assertEqual(len(rpc.calls), 2)

    def test_default_engine_still_refuses_images(self):
        result = fixtures.engine(fixtures.Rpc(plan)).run("x")
        self.assertEqual(result["metadata"]["code"], "TOOL_EVENT_REFUSED")
        self.assertEqual(n.WORK_SECONDS, 125.0); self.assertEqual(n.EVENT_BYTES_CAP, 262144)
        self.assertEqual(engine(clock=lambda: 10)._turn_deadline(), 310)

    def test_frame_above_12mib_refused_before_export(self):
        rpc = fixtures.Rpc(lambda turn:[{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","extra":"x"*w.IMAGE_FRAME_BYTES}}])
        result = engine(rpc).run("x")
        self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        self.assertFalse(result["imageMetadata"]["exportReady"])

    def test_image_only_300_second_deadline_is_used_by_actual_base_run(self):
        at = [0.0]
        class SlowRpc(fixtures.Rpc):
            def exchange(self, method, params, timeout):
                result = super().exchange(method, params, timeout)
                if method == "turn/start": at[0] = 200.0
                return result
        e = engine(SlowRpc(plan), clock=lambda:at[0])
        self.assertEqual(e.run("image")["metadata"]["code"], "OK")
        at[0] = 0.0
        ordinary = fixtures.engine(SlowRpc(), clock=lambda:at[0]).run("text")
        self.assertEqual(ordinary["metadata"]["code"], "TRANSPORT_UNKNOWN")
        self.assertEqual(n.WORK_SECONDS, 125.0)

    def test_large_ack_arbitrary_fields_do_not_evade_ordinary_budget(self):
        class ExtraAck(fixtures.Rpc):
            def exchange(self, method, params, timeout):
                result, error = super().exchange(method, params, timeout)
                if method == "turn/start":
                    result["turn"]["items"] = [image(data=large_png())]
                    result["arbitrary"] = "x" * 262145
                return result, error
        e = engine(ExtraAck(plan)); result = e.run("image")
        self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        self.assertFalse(result["imageMetadata"]["exportReady"])

    def test_decoded_image_limit_and_conflicting_duplicate_revoke(self):
        for data in (large_png(8 * 1024 * 1024), large_png(1)):
            def invalid(turn):
                events = plan(turn)
                events.insert(2, event(turn, True, image(data=data)))
                return events
            e = engine(fixtures.Rpc(invalid)); result = e.run("image")
            self.assertNotEqual(result["metadata"]["code"], "OK")
            self.assertFalse(result["imageMetadata"]["exportReady"])
            with self.assertRaises(Exception): e.image_artifact()

    def test_unvalidated_request_cannot_gain_image_byte_exemption(self):
        def forged(turn):
            frame = event(turn, True, image(data=large_png()))
            frame["id"] = 77
            return [frame]
        result = engine(fixtures.Rpc(forged)).run("image")
        self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        self.assertEqual(result["imageMetadata"]["evidenceCount"], 0)

if __name__ == "__main__": unittest.main()
