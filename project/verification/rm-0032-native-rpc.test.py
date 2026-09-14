"""Offline codec + synthetic anonymous-pipe tests. No processes/network/auth.
Linux cases use only os.pipe and local threads; Windows runs pure codec cases.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import threading
import time
import types
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


root = Path(__file__).parent
rpc_module = load("native_rpc_fixture", root / "rm-0032-native-rpc.py")


class CodecTests(unittest.TestCase):
    def test_exact_native_ids_and_unicode(self):
        for request_id in [-(2**63), 2**63 - 1, "call-a"]:
            value = {"id": request_id, "method": "item/tool/call", "params": {"text": 'Р В РЎС›Р В Р’ВµР В РЎвЂќР РЋР С“Р РЋРІР‚С™ "\\" РЎР‚РЎСџР’В¤РЎСљ'}}
            decoded = rpc_module.decode_frame(rpc_module.encode_frame(value))
            self.assertEqual(decoded, value); self.assertIs(type(decoded["id"]), type(request_id))
        normalized = rpc_module.decode_frame(b'{"jsonrpc":"2.0","id":9223372036854775807,"method":"item/tool/call","params":{}}\n')
        self.assertEqual(set(normalized), {"id", "method", "params"}); self.assertEqual(normalized["id"], 2**63 - 1)
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.decode_frame(b'{"jsonrpc":"1.0","method":"notice"}\n')

    def test_duplicate_keys_utf8_nonfinite_and_shape_refused(self):
        invalid = [b'{"id":"a","id":"b","result":{}}\n', b'{"id":"a","result":{"x":1,"x":2}}\n',
                   b'{"method":"note","params":{"x":NaN}}\n', b'{"method":"note","params":{"x":1e400}}\n',
                   b'{"method":"\xff"}\n', b'{"method":"\\ud800"}\n', b'{"id":true,"result":{}}\n',
                   b'{"id":9223372036854775808,"result":{}}\n', b'{"id":"x","result":{},"error":{"code":1}}\n', b'[]\n', b'{"method":"x"}']
        for raw in invalid:
            with self.subTest(raw_length=len(raw)), self.assertRaises(rpc_module.NativeRpcError) as caught:
                rpc_module.decode_frame(raw)
            self.assertEqual(str(caught.exception), "PROTOCOL_REFUSED")

    def test_fixed_parse_sites_without_raw_payloads(self):
        for raw, site in ((b'{"method":broken}\n', "json"), (b'{"method":"x","private":"secret"}\n', "envelope"),
                          (b'{"jsonrpc":"1.0","method":"x"}\n', "marker"), (b'{"method":"x","params":null}\n', "payload")):
            with self.assertRaises(rpc_module.NativeRpcError) as caught: rpc_module.decode_frame(raw)
            self.assertEqual(caught.exception.site, site); self.assertEqual(str(caught.exception), "PROTOCOL_REFUSED")

    def test_rejected_envelope_shape_is_fixed_and_private(self):
        frames = [{"method": "configWarning", "params": {"message": "PRIVATE payload"}, "_meta": {"PRIVATE key": "PRIVATE value"}, "PRIVATE unknown key": "PRIVATE value"},
                  ["PRIVATE array"], "PRIVATE string"]
        for frame in frames:
            with self.assertRaises(rpc_module.NativeRpcError) as caught: rpc_module.decode_frame(rpc_module.encode_frame(frame))
            shape = caught.exception.shape
            self.assertEqual(caught.exception.site, "envelope"); self.assertNotIn("PRIVATE", json.dumps(shape))
        with self.assertRaises(rpc_module.NativeRpcError) as caught: rpc_module.decode_frame(rpc_module.encode_frame(frames[0]))
        shape = caught.exception.shape
        self.assertEqual(shape, {"type": "object", "keys": (1 << 1) | (1 << 2) | (1 << 7), "unknownKeys": 1,
                                "method": "configWarning", "idType": "absent", "paramsType": "object"})

    def test_installed_notification_timestamp_normalizes_only_notification_int64(self):
        for stamp in (-(2**63), 0, 2**63 - 1):
            for method in ("configWarning", "item/completed"):
                frame = {"method": method, "params": {"summary": "synthetic"}, "emittedAtMs": stamp}
                self.assertEqual(rpc_module.decode_frame(rpc_module.encode_frame(frame)), {"method": method, "params": frame["params"]})
        for stamp in (True, False, None, "123", 1.5, -(2**63)-1, 2**63):
            with self.assertRaises(rpc_module.NativeRpcError): rpc_module.decode_frame(rpc_module.encode_frame({"method": "configWarning", "params": {}, "emittedAtMs": stamp}))
        for frame in ({"id": "r", "method": "item/tool/call", "params": {}, "emittedAtMs": 1},
                      {"id": "r", "result": {}, "emittedAtMs": 1}, {"id": "r", "error": {"code": -1}, "emittedAtMs": 1},
                      {"method": "configWarning", "params": {}, "emittedAtMs": 1, "PRIVATE unknown field": "PRIVATE"}):
            with self.assertRaises(rpc_module.NativeRpcError): rpc_module.decode_frame(rpc_module.encode_frame(frame))

    def test_three_mib_frame_limit_and_large_history_supported(self):
        large = {"method": "item/completed", "params": {"text": "x" * (2 * 1024 * 1024)}}
        self.assertEqual(rpc_module.decode_frame(rpc_module.encode_frame(large)), large)
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.encode_frame({"method": "x", "params": {"text": "x" * rpc_module.FRAME_CAP}})

    def test_image_profile_is_explicit_bounded_and_default_text_unchanged(self):
        self.assertEqual(rpc_module.profile_limits("text"), (3*1024*1024, 8*1024*1024))
        self.assertEqual(rpc_module.profile_limits("image"), (12*1024*1024, 32*1024*1024))
        frame = {"method": "item/completed", "params": {"result": "A"*(4*((8*1024*1024+2)//3))}}
        raw = rpc_module.encode_frame(frame, profile="image")
        self.assertLess(len(raw), 12*1024*1024)
        self.assertEqual(rpc_module.decode_frame(raw, profile="image"), frame)
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.encode_frame(frame)
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.decode_frame(raw)
        for profile in ("other", None, {}, 12*1024*1024):
            with self.assertRaises(rpc_module.NativeRpcError) as caught: rpc_module.NativeRpc(None, profile=profile)
            self.assertEqual(caught.exception.code, "CONFIG_REFUSED")
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.encode_frame({"method": "item/completed", "params": {"x": "x"*rpc_module.IMAGE_FRAME_CAP}}, profile="image")
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.decode_frame(b'{"method":"x","params":{"x":NaN}}\n', profile="image")

    def test_buffered_streams_are_not_claimed_deadline_safe(self):
        with self.assertRaises(rpc_module.NativeRpcError): rpc_module.NativeRpc(types.SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO()))


class Peer:
    def __init__(self, test, profile="text"):
        self.profile = profile
        self.test, self.errors, self.threads = test, [], []
        read_in, write_in = os.pipe(); read_out, write_out = os.pipe()
        self.server_in, self.server_out = io.FileIO(read_in, "rb"), io.FileIO(write_out, "wb")
        self.proc = types.SimpleNamespace(stdin=io.FileIO(write_in, "wb"), stdout=io.FileIO(read_out, "rb"))
        self.rpc = rpc_module.NativeRpc(self.proc, profile=profile)

    def send(self, value):
        data = rpc_module.encode_frame(value, profile=self.profile); offset = 0
        while offset < len(data): offset += os.write(self.server_out.fileno(), data[offset:])

    def receive(self):
        line = self.server_in.readline(rpc_module.profile_limits(self.profile)[0] + 1)
        if not line: return None
        return json.loads(line)

    def worker(self, callback):
        def run():
            try: callback()
            except (BrokenPipeError, OSError, ValueError): pass  # Expected only when test closes owned pipes.
            except BaseException as error: self.errors.append(type(error).__name__)
        thread = threading.Thread(target=run, daemon=True); self.threads.append(thread); thread.start()

    def initialize(self):
        def reply():
            value = self.receive(); self.test.assertEqual(value["method"], "initialize")
            self.send({"id": value["id"], "result": {"ready": True}})
            self.test.assertEqual(self.receive(), {"method": "initialized"})
        self.worker(reply)
        self.test.assertEqual(self.rpc.exchange("initialize", {}, 1), ({"ready": True}, None)); self.rpc.initialized()
        self.threads[-1].join(1); self.test.assertFalse(self.threads[-1].is_alive()); self.rpc.admit_model()

    def __enter__(self): return self
    def __exit__(self, *_):
        self.rpc.close()
        self.server_out.close()
        for thread in self.threads: thread.join(1); self.test.assertFalse(thread.is_alive(), "synthetic peer did not stop")
        self.server_in.close(); self.test.assertEqual(self.errors, [])


@unittest.skipUnless(sys.platform == "linux", "Anonymous-pipe selector contract is Linux-only")
class PipeTests(unittest.TestCase):
    def test_image_wait_budget_accepts_300_without_changing_text_125(self):
        frame = {"method": "skills/changed", "params": {}}
        for profile, seconds, accepted in (("text", 125, True), ("image", 300, True),
                ("text", 125.001, False), ("image", 300.001, False),
                ("image", True, False), ("image", float("inf"), False)):
            with self.subTest(profile=profile, seconds=seconds), Peer(self, profile) as p:
                p.initialize()
                p.send(frame)
                if accepted:
                    self.assertEqual(p.rpc.next_frame(seconds), frame)
                else:
                    with self.assertRaises(rpc_module.NativeRpcError) as caught:
                        p.rpc.next_frame(seconds)
                    self.assertEqual(caught.exception.code, "BOUNDS_REFUSED")

    def test_capabilities_read_is_custody_only_in_both_profiles(self):
        for profile in ("text", "image"):
            with self.subTest(profile=profile), Peer(self, profile) as p:
                methods = []
                def server():
                    while True:
                        value = p.receive()
                        if value is None: return
                        methods.append(value["method"])
                        if value["method"] == "initialized": continue
                        p.send({"id": value["id"], "result": {"capabilities": {"imageGeneration": True}}})
                p.worker(server)
                p.rpc.exchange("initialize", {}, 1); p.rpc.initialized()
                answer, error = p.rpc.exchange("modelProvider/capabilities/read", {}, 1)
                self.assertIsNone(error); self.assertTrue(answer["capabilities"]["imageGeneration"])
                p.rpc.admit_model()
                with self.assertRaises(rpc_module.NativeRpcError): p.rpc.exchange("modelProvider/capabilities/read", {}, 1)
                self.assertEqual(methods.count("modelProvider/capabilities/read"), 1)
                self.assertEqual(p.rpc.metadata()["profile"], profile)

    def test_two_max_image_echoes_queue_before_ack_and_third_refuses_aggregate(self):
        # Invented base64-sized text only, never an image/model/network operation.
        echo = {"method": "item/completed", "params": {"result": "A"*(4*((8*1024*1024+2)//3))}}
        for count in (2, 3):
            with self.subTest(count=count), Peer(self, "image") as p:
                p.initialize()
                def server():
                    value = p.receive()
                    for _ in range(count): p.send(echo)
                    p.send({"id": value["id"], "result": {"turn": {}}})
                p.worker(server)
                if count == 2:
                    self.assertEqual(p.rpc.exchange("turn/start", {}, 5), ({"turn": {}}, None))
                    self.assertEqual(p.rpc.metadata()["queuedFrames"], 2)
                    self.assertGreater(p.rpc.metadata()["queuedBytes"], rpc_module.QUEUE_BYTES)
                    for _ in range(2): self.assertEqual(p.rpc.next_frame(1), echo)
                    self.assertEqual(p.rpc.metadata()["queuedBytes"], 0)
                else:
                    with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.exchange("turn/start", {}, 5)
                    self.assertEqual(caught.exception.code, "BOUNDS_REFUSED")
                    self.assertTrue(p.rpc.metadata()["unknown"])

    def test_initialized_respects_remaining_deadline_under_backpressure(self):
        with Peer(self) as p:
            p.worker(lambda: (lambda request: p.send({"id": request["id"], "result": {}}))(p.receive()))
            self.assertEqual(p.rpc.exchange("initialize", {}, 1), ({}, None))
            p.threads[-1].join(1)
            # Fill the real nonblocking stdin pipe after the initialize ACK.
            while True:
                try: os.write(p.proc.stdin.fileno(), b"x" * 4096)
                except BlockingIOError: break
            before = time.monotonic()
            with self.assertRaises(rpc_module.NativeRpcError) as caught:
                p.rpc.initialized(.03)
            self.assertEqual(caught.exception.code, "TRANSPORT_UNKNOWN")
            self.assertLess(time.monotonic() - before, .5)
            self.assertEqual(p.rpc.metadata()["phase"], "poisoned")

    def test_first_failure_projection_survives_shutdown_and_distinguishes_timeout_eof_parse(self):
        for mode, site in (("json", "json"), ("eof", "eof"), ("timeout", "deadline")):
            with self.subTest(mode=mode), Peer(self) as p:
                def server():
                    p.receive()
                    if mode == "json": os.write(p.server_out.fileno(), b'{"PRIVATE": broken}\n')
                    if mode == "eof": p.server_out.close()
                    p.receive()  # Wait only for exact client EOF during cleanup.
                p.worker(server)
                with self.assertRaises(rpc_module.NativeRpcError): p.rpc.exchange("initialize", {}, .1)
                before = p.rpc.metadata()
                self.assertEqual(before["firstFailure"]["site"], site)
                self.assertEqual(before["firstFailure"]["operation"], "initialize")
                self.assertEqual(before["firstFailure"]["phase"], "custody")
                self.assertEqual(before["bytesRead"] > 0, mode == "json")
                p.rpc.close_input(); p.threads[-1].join(1)
                if not p.server_out.closed: p.server_out.close()
                self.assertTrue(p.rpc.drain_to_eof(1))
                self.assertEqual(p.rpc.metadata()["firstFailure"], before["firstFailure"])
                self.assertNotIn("PRIVATE", json.dumps(p.rpc.metadata()))

    def test_init_plus_bad_auxiliary_envelope_batched_or_after_initialized(self):
        for batched in (True, False):
            with self.subTest(batched=batched), Peer(self) as p:
                extra = {"method": "configWarning", "params": {"message": "PRIVATE value"}, "_meta": {"PRIVATE key": "PRIVATE value"}}
                def server():
                    request = p.receive()
                    ack = rpc_module.encode_frame({"id": request["id"], "result": {"ready": True}})
                    if batched:
                        os.write(p.server_out.fileno(), ack + rpc_module.encode_frame(extra))
                    else:
                        os.write(p.server_out.fileno(), ack)
                        self.assertEqual(p.receive(), {"method": "initialized"})
                        p.send(extra)
                    while p.receive() is not None: pass
                p.worker(server)
                with self.assertRaises(rpc_module.NativeRpcError):
                    p.rpc.exchange("initialize", {}, 1)
                    p.rpc.initialized()
                    p.rpc.exchange("permissionProfile/list", {}, 1)
                before = p.rpc.metadata()
                self.assertEqual(before["firstFailure"]["site"], "envelope")
                self.assertEqual(before["failureEnvelope"]["keys"], (1 << 1) | (1 << 2) | (1 << 7))
                self.assertEqual(before["failureEnvelope"]["method"], "configWarning")
                self.assertEqual(before["framesRead"], 1)
                self.assertNotIn("PRIVATE", json.dumps(before))
                p.rpc.close_input(); p.threads[-1].join(1); p.server_out.close()
                self.assertTrue(p.rpc.drain_to_eof(1)); self.assertEqual(p.rpc.metadata()["failureEnvelope"], before["failureEnvelope"])

    def test_unchanged_custody_protocol_then_phase_switch(self):
        base = load("custody_offline_fixture", root / "rm-0032-managed-custody-client.py")
        with Peer(self) as p:
            methods = []
            def server():
                probe = 0
                while True:
                    frame = p.receive()
                    if frame is None: return
                    method = frame["method"]; methods.append(method)
                    if method == "initialized": continue
                    if method == "initialize": result = {"platformOs": "linux", "platformFamily": "unix", "codexHome": base.AUTH_HOME, "userAgent": base.CLIENT + "/0.153.4 (fixture)"}
                    elif method == "permissionProfile/list": result = {"data": [{"id": base.PROFILE, "allowed": True}], "nextCursor": None}
                    elif method == "command/exec":
                        name = base.base_result()["probes"][probe]["name"]; probe += 1
                        result = {"exitCode": sorted(base.pass_codes(name))[0], "stdout": "", "stderr": ""}
                    elif method == "account/read": result = {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": False}
                    elif method == "model/list": result = {"data": [{"model": "gpt-6-astra", "hidden": False, "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}], "nextCursor": None}
                    else: self.fail("unexpected offline method")
                    p.send({"id": frame["id"], "result": result})
            p.worker(server); result = base.base_result(); base.protocol(p.rpc, result, 12345)
            self.assertTrue(result["initialize"]); self.assertTrue(all(r["verdict"] == "pass" for r in result["probes"]))
            self.assertEqual(methods.count("command/exec"), 9); p.rpc.admit_model()
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.exchange("command/exec", {}, .1)
            self.assertEqual(methods.count("command/exec"), 9)

    def test_notifications_and_requests_before_ack_preserve_exact_order_two_turns(self):
        with Peer(self) as p:
            p.initialize()
            def server():
                for turn in range(2):
                    frame = p.receive(); self.assertEqual(frame["method"], "turn/start"); self.assertIs(type(frame["id"]), str)
                    p.send({"method": "before", "params": {"turn": turn}})
                    p.send({"id": 2**63 - 1 - turn, "method": "item/tool/call", "params": {"turn": turn}})
                    p.send({"id": frame["id"], "result": {"turn": turn}})
                    reply = p.receive(); self.assertEqual(reply["id"], 2**63 - 1 - turn); self.assertIs(type(reply["id"]), int)
                    p.send({"method": "after", "params": {"turn": turn}})
            p.worker(server)
            for turn in range(2):
                self.assertEqual(p.rpc.exchange("turn/start", {}, 1), ({"turn": turn}, None))
                self.assertEqual(p.rpc.next_frame(1)["method"], "before")
                request = p.rpc.next_frame(1); p.rpc.respond(request["id"], {"success": True}, 1)
                self.assertEqual(p.rpc.next_frame(1)["method"], "after")
            self.assertEqual(p.rpc.metadata()["responsesWritten"], 2); self.assertEqual(p.rpc.metadata()["queuedBytes"], 0)

    def test_duplicate_request_id_and_duplicate_response_are_refused(self):
        with Peer(self) as p:
            p.initialize()
            p.worker(lambda: (p.send({"id": 9, "method": "tool", "params": {}}), p.send({"id": 9, "method": "tool", "params": {}})))
            with self.assertRaises(rpc_module.NativeRpcError):
                p.rpc.next_frame(1); p.rpc.next_frame(1)
        with Peer(self) as p:
            p.initialize(); p.worker(lambda: p.send({"id": "request", "method": "tool", "params": {}}))
            request = p.rpc.next_frame(1); p.rpc.respond(request["id"], {}, 1)
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.respond(request["id"], {}, 1)

    def test_wrong_client_response_id_and_custody_server_request_refuse(self):
        for frame in [{"id": "wrong", "result": {}}, {"id": 22, "method": "tool", "params": {}}]:
            with Peer(self) as p:
                p.worker(lambda: (p.receive(), p.send(frame)))
                with self.assertRaises(rpc_module.NativeRpcError): p.rpc.exchange("initialize", {}, 1)
                self.assertEqual(p.rpc.metadata()["phase"], "poisoned")

    def test_backpressure_write_timeout_is_hard_and_late_write_cannot_resume(self):
        with Peer(self) as p:
            p.initialize(); before = time.monotonic()
            with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.exchange("turn/start", {"text": "x" * (2 * 1024 * 1024)}, .08)
            self.assertEqual(caught.exception.code, "TRANSPORT_UNKNOWN"); self.assertTrue(caught.exception.unknown)
            self.assertLess(time.monotonic() - before, .8)
            drained = bytearray(); os.set_blocking(p.server_in.fileno(), False)
            while True:
                try: drained.extend(os.read(p.server_in.fileno(), 65536))
                except BlockingIOError: break
            self.assertGreater(len(drained), 0); self.assertNotIn(b"\n", drained)
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.exchange("turn/start", {}, 1)
            time.sleep(.02)
            with self.assertRaises(BlockingIOError): os.read(p.server_in.fileno(), 65536)

    def test_read_timeout_poisons_and_shutdown_drain_remains_bounded(self):
        with Peer(self) as p:
            p.initialize(); before = time.monotonic()
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.next_frame(.03)
            self.assertLess(time.monotonic() - before, .5)
            p.rpc.close_input(); before = time.monotonic(); self.assertFalse(p.rpc.drain_to_eof(.03)); self.assertLess(time.monotonic() - before, .5)
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.exchange("turn/start", {}, .1)
            self.assertFalse(p.rpc.metadata()["stdoutEofObserved"])

    def test_shutdown_drains_large_tail_without_flush_or_process_settlement_claim(self):
        with Peer(self) as p:
            p.initialize()
            def tail():
                self.assertIsNone(p.receive()); p.send({"method": "tail", "params": {"text": "x" * (2 * 1024 * 1024)}}); p.server_out.close()
            p.worker(tail); p.rpc.close_input(); self.assertTrue(p.rpc.drain_to_eof(1))
            self.assertTrue(p.rpc.metadata()["stdoutEofObserved"]); self.assertGreater(p.rpc.metadata()["shutdownDiscardedBytes"], 2 * 1024 * 1024)
            self.assertNotIn("processSettled", p.rpc.metadata())

    def test_queue_count_bounds_interleaved_events_before_ack(self):
        with Peer(self) as p:
            p.initialize()
            def flood():
                p.receive()
                for i in range(65): p.send({"method": "notification", "params": {"index": i}})
            p.worker(flood)
            with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.exchange("turn/start", {}, 1)
            self.assertEqual(caught.exception.code, "BOUNDS_REFUSED")

    def test_large_history_events_drain_without_cumulative_lifetime_byte_cap(self):
        with Peer(self) as p:
            p.initialize()
            p.worker(lambda: [p.send({"method": "history", "params": {"text": "x" * (2 * 1024 * 1024)}}) for _ in range(7)])
            for _ in range(7): self.assertEqual(len(p.rpc.next_frame(2)["params"]["text"]), 2 * 1024 * 1024)
            self.assertEqual(p.rpc.metadata()["phase"], "model"); self.assertEqual(p.rpc.metadata()["queuedBytes"], 0)


if __name__ == "__main__":
    unittest.main()
