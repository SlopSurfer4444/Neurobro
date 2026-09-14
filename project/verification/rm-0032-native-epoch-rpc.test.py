"""New epoch idle tests over unchanged canonical RPC test fixtures.

Linux adds actual anonymous-pipe selector cases; deterministic port cases run
on Windows. The historical fixture file is imported, not copied or re-run.
"""
import importlib.util
from pathlib import Path
import sys
import threading
import time
import types
import json
import os
import unittest
from unittest import mock


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


root = Path(__file__).parent
fixture = load("native_rpc_test_fixture", root / "rm-0032-native-rpc.test.py")
rpc_module = fixture.rpc_module
OriginalRpc = rpc_module.NativeRpc
epoch_module = load("native_epoch_rpc_fixture", root / "rm-0032-native-epoch-rpc.py")
rpc_module.NativeRpc = epoch_module.create_epoch_rpc_class(rpc_module)
rpc_module.IDLE = epoch_module.IDLE
Peer = fixture.Peer


class ScriptedPoll:
    """Real FileIO pipe ownership, synthetic readiness/read ports, no process.

    Enables deterministic transport boundary tests on Windows too. Linux PipeTests
    separately cover the actual selector implementation without patched I/O.
    """
    def __init__(self, test, chunks=()):
        self.test, self.chunks = test, list(chunks)
        self.patches = []

    def __enter__(self):
        with mock.patch.object(rpc_module.sys, "platform", "linux"):
            self.peer = Peer(self.test)
        self.rpc = self.peer.rpc
        self.rpc._phase, self.rpc._initialized = "model", True  # Synthetic admission only.
        owner = self
        class Selector:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def register(self, fd, events):
                owner.test.assertEqual((fd, events), (owner.rpc._read_fd, rpc_module.selectors.EVENT_READ))
            def select(self, timeout):
                return [(types.SimpleNamespace(fd=owner.rpc._read_fd), rpc_module.selectors.EVENT_READ)] if owner.chunks else []
        def read(fd, size):
            self.test.assertEqual((fd, size), (self.rpc._read_fd, 65536))
            value = self.chunks.pop(0)
            if isinstance(value, Exception): raise value
            return value
        self.patches = [mock.patch.object(rpc_module.selectors, "DefaultSelector", Selector),
                        mock.patch.object(rpc_module.os, "read", read)]
        for patch in self.patches: patch.start()
        return self

    def __exit__(self, *args):
        for patch in reversed(self.patches): patch.stop()
        self.peer.__exit__(*args)


class PollTests(unittest.TestCase):
    def test_historical_parser_profiles_and_receive_implementation_are_inherited(self):
        self.assertNotIn("next_frame", rpc_module.NativeRpc.__dict__)
        self.assertNotIn("_ingest", rpc_module.NativeRpc.__dict__)
        self.assertNotIn("_wait", rpc_module.NativeRpc.__dict__)
        self.assertNotIn("__init__", rpc_module.NativeRpc.__dict__)
        for name in ("next_frame", "_ingest", "_wait", "__init__", "respond", "metadata"):
            self.assertIs(getattr(rpc_module.NativeRpc, name), getattr(OriginalRpc, name))
        self.assertEqual(rpc_module.profile_limits("image"), (12 * 1024 * 1024, 32 * 1024 * 1024))

    def test_delayed_positive_selector_readiness_preserves_partial_without_reading(self):
        frame = {"method": "turn/completed", "params": {"turn": {"id": "late"}}}
        raw = rpc_module.encode_frame(frame)
        with ScriptedPoll(self, [raw[:9]]) as p:
            self.assertIs(p.rpc.poll_frame(), rpc_module.IDLE)
            p.chunks.append(raw[9:])
            before = p.rpc.metadata()
            # Monotonic samples: admission, pre-select, delayed return.
            # Selector reports readable, but the positive .1s budget is gone.
            with mock.patch.object(epoch_module.time, "monotonic", side_effect=[100.0, 100.0, 100.0, 100.2]):
                self.assertIs(p.rpc.poll_frame(.1), rpc_module.IDLE)
            self.assertEqual(p.chunks, [raw[9:]])
            self.assertEqual(p.rpc.metadata(), before)
            self.assertEqual(p.rpc.idle_state()["partialBytes"], 9)
            self.assertEqual(p.rpc.poll_frame(), frame)

    def test_idle_wait_is_nonpoisoning_then_next_frame_uses_same_partial_reader(self):
        value = {"method": "turn/started", "params": {"text": "бро"}}
        raw = rpc_module.encode_frame(value)
        cut = raw.index("бро".encode()) + 1
        with ScriptedPoll(self) as p:
            before = p.rpc.metadata()
            self.assertIs(p.rpc.poll_frame(.01), rpc_module.IDLE)
            self.assertEqual(p.rpc.metadata(), before)
            p.chunks.append(raw[:cut])
            self.assertIs(p.rpc.poll_frame(), rpc_module.IDLE)
            self.assertEqual(p.rpc.idle_state()["partialBytes"], cut)
            p.chunks.append(raw[cut:])
            self.assertEqual(p.rpc.next_frame(.5), value)
            self.assertEqual(p.rpc.idle_state(), {"partialBytes": 0, "queuedFrames": 0, "pendingRequests": 0, "stdoutEofObserved": False})
            self.assertEqual(p.rpc.metadata()["code"], "OK")

    def test_parse_finishing_after_poll_budget_preserves_complete_frame_for_next_call(self):
        frame = {"method": "thread/status/changed", "params": {"threadId": "old"}}
        with ScriptedPoll(self, [rpc_module.encode_frame(frame)]) as p:
            now = [100.0]
            ingest = p.rpc._ingest
            def delayed_ingest(): ingest(); now[0] = 100.2
            with mock.patch.object(epoch_module.time, "monotonic", lambda: now[0]), mock.patch.object(p.rpc, "_ingest", delayed_ingest):
                self.assertIs(p.rpc.poll_frame(.1), rpc_module.IDLE)
            self.assertEqual(p.rpc.idle_state()["queuedFrames"], 1)
            self.assertEqual(p.rpc.poll_frame(), frame)
            self.assertEqual(p.rpc.metadata()["code"], "OK")

    def test_observed_eof_is_not_hidden_by_expired_positive_budget(self):
        with ScriptedPoll(self, [b""]) as p:
            now = [100.0]; ingest = p.rpc._ingest
            def delayed_ingest(): ingest(); now[0] = 100.2
            with mock.patch.object(epoch_module.time, "monotonic", lambda: now[0]), mock.patch.object(p.rpc, "_ingest", delayed_ingest):
                with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.poll_frame(.1)
            self.assertEqual(caught.exception.code, "TRANSPORT_UNKNOWN")
            self.assertEqual(p.rpc.metadata()["firstFailure"]["site"], "eof")
            self.assertTrue(p.rpc.metadata()["stdoutEofObserved"])

    def test_expired_setup_keeps_prequeued_frame_undelivered(self):
        frames = [{"method": "first", "params": {}}, {"method": "second", "params": {}}]
        with ScriptedPoll(self, [b"".join(rpc_module.encode_frame(frame) for frame in frames)]) as p:
            self.assertEqual(p.rpc.poll_frame(), frames[0])
            with mock.patch.object(epoch_module.time, "monotonic", side_effect=[100.0, 100.2]):
                self.assertIs(p.rpc.poll_frame(.1), rpc_module.IDLE)
            self.assertEqual(p.rpc.idle_state()["queuedFrames"], 1)
            self.assertEqual(p.rpc.poll_frame(), frames[1])

    def test_coalesced_late_lifecycle_compaction_and_error_are_not_swallowed(self):
        frames = [{"method": "thread/compacted", "params": {"threadId": "old"}},
                  {"method": "error", "params": {"message": "synthetic"}},
                  {"method": "unrecognized/lifecycle", "params": {}},
                  {"method": "turn/completed", "params": {"turn": {"id": "old"}}}]
        with ScriptedPoll(self, [b"".join(rpc_module.encode_frame(f) for f in frames)]) as p:
            self.assertEqual(p.rpc.poll_frame(), frames[0])
            self.assertEqual(p.rpc.idle_state()["queuedFrames"], 3)
            for frame in frames[1:]: self.assertEqual(p.rpc.poll_frame(), frame)
            self.assertIs(p.rpc.poll_frame(), rpc_module.IDLE)
            self.assertEqual(p.rpc.metadata()["framesRead"], 4)

    def test_late_request_retains_exact_id_and_explicit_response_accounting(self):
        frame = {"id": 2**63 - 1, "method": "item/tool/call", "params": {"callId": "late"}}
        with ScriptedPoll(self, [rpc_module.encode_frame(frame)]) as p:
            self.assertEqual(p.rpc.poll_frame(), frame)
            self.assertEqual(p.rpc.idle_state()["pendingRequests"], 1)
            self.assertEqual(p.rpc.metadata()["responsesWritten"], 0)
            captured = []
            with mock.patch.object(p.rpc, "_write", lambda value, deadline: captured.append(value)):
                p.rpc.respond(frame["id"], {"success": False}, .5)
            self.assertEqual(captured, [{"id": 2**63 - 1, "result": {"success": False}}])
            self.assertIs(type(captured[0]["id"]), int)
            self.assertEqual(p.rpc.idle_state()["pendingRequests"], 0)
            p.chunks.append(rpc_module.encode_frame(frame))
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.poll_frame()

    def test_unsolicited_response_and_malformed_frame_are_fatal(self):
        for raw in [b'{"id":"late","result":{}}\n', b'{"method":"x","method":"y"}\n']:
            with ScriptedPoll(self, [raw]) as p:
                with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.poll_frame()
                self.assertEqual(caught.exception.code, "PROTOCOL_REFUSED")
                self.assertTrue(caught.exception.unknown)
                self.assertEqual(p.rpc.metadata()["phase"], "poisoned")

    def test_eof_with_or_without_partial_is_never_idle_or_settlement(self):
        for partial in [b"", b'{"method":']:
            with ScriptedPoll(self, ([partial] if partial else []) + [b""]) as p:
                if partial: self.assertIs(p.rpc.poll_frame(), rpc_module.IDLE)
                with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.poll_frame()
                self.assertEqual(caught.exception.code, "TRANSPORT_UNKNOWN")
                self.assertEqual(p.rpc.metadata()["firstFailure"]["site"], "eof")
                self.assertTrue(p.rpc.metadata()["stdoutEofObserved"])
                self.assertNotIn("processSettled", p.rpc.metadata())

    def test_read_and_selector_errors_are_fatal_not_idle(self):
        with ScriptedPoll(self, [OSError("PRIVATE")]) as p:
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.poll_frame()
            self.assertEqual(p.rpc.metadata()["firstFailure"]["site"], "read")
            self.assertNotIn("PRIVATE", json.dumps(p.rpc.metadata()))
        with ScriptedPoll(self) as p:
            with mock.patch.object(rpc_module.selectors, "DefaultSelector", side_effect=OSError("PRIVATE")):
                with self.assertRaises(rpc_module.NativeRpcError): p.rpc.poll_frame()
            self.assertEqual(p.rpc.metadata()["firstFailure"]["site"], "selector")

    def test_poll_bounds_phase_and_existing_next_timeout_remain_strict(self):
        for seconds in [True, -1, 1.001, float("nan"), float("inf"), "0"]:
            with ScriptedPoll(self) as p:
                with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.poll_frame(seconds)
                self.assertEqual(caught.exception.code, "BOUNDS_REFUSED")
        with ScriptedPoll(self) as p:
            p.rpc._phase = "custody"
            with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.poll_frame()
            self.assertEqual(caught.exception.code, "PHASE_REFUSED")
        with ScriptedPoll(self) as p:
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.next_frame(.01)
            self.assertEqual(p.rpc.metadata()["firstFailure"]["site"], "deadline")

    def test_concurrent_reader_exclusion_does_not_return_false_idle(self):
        with ScriptedPoll(self) as p:
            entered, release, result = threading.Event(), threading.Event(), []
            class WaitingSelector:
                def __enter__(self): return self
                def __exit__(self, *_): pass
                def register(self, *_): pass
                def select(self, _): entered.set(); release.wait(1); return []
            def poll():
                try: result.append(p.rpc.poll_frame(.5))
                except rpc_module.NativeRpcError as error: result.append(error.code)
            with mock.patch.object(rpc_module.selectors, "DefaultSelector", WaitingSelector):
                thread = threading.Thread(target=poll); thread.start()
                try:
                    self.assertTrue(entered.wait(1))
                    with self.assertRaises(rpc_module.NativeRpcError) as caught: p.rpc.idle_state()
                    self.assertEqual(caught.exception.code, "CONCURRENT_REFUSED")
                finally: release.set(); thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result, ["CONCURRENT_REFUSED"])


@unittest.skipUnless(sys.platform == "linux", "Anonymous-pipe selector contract is Linux-only")
class PipeTests(unittest.TestCase):
    def test_actual_idle_then_partial_timeout_then_next_turn_with_same_reader(self):
        with Peer(self) as p:
            p.initialize(); before = time.monotonic()
            self.assertIs(p.rpc.poll_frame(.03), rpc_module.IDLE)
            self.assertLess(time.monotonic() - before, .5)
            self.assertEqual(p.rpc.metadata()["phase"], "model")
            frame = {"method": "turn/started", "params": {"text": "бро"}}
            raw = rpc_module.encode_frame(frame); cut = raw.index("бро".encode()) + 1
            os.write(p.server_out.fileno(), raw[:cut])
            self.assertIs(p.rpc.poll_frame(.03), rpc_module.IDLE)
            self.assertEqual(p.rpc.idle_state()["partialBytes"], cut)
            os.write(p.server_out.fileno(), raw[cut:])
            self.assertEqual(p.rpc.next_frame(.5), frame)

    def test_actual_idle_eof_and_late_request_refusal_response(self):
        with Peer(self) as p:
            p.initialize()
            frame = {"id": 2**63 - 1, "method": "item/tool/call", "params": {"callId": "late"}}
            p.send(frame); self.assertEqual(p.rpc.poll_frame(.5), frame)
            p.rpc.respond(frame["id"], {"success": False}, .5)
            self.assertEqual(p.receive(), {"id": frame["id"], "result": {"success": False}})
            p.server_out.close()
            with self.assertRaises(rpc_module.NativeRpcError): p.rpc.poll_frame(.5)
            self.assertEqual(p.rpc.metadata()["firstFailure"]["site"], "eof")


if __name__ == "__main__":
    unittest.main()
