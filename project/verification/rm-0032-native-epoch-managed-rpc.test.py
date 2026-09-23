"""Managed epoch lifetime tests: fake clock plus actual Linux anonymous pipes."""
import importlib.util
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest import mock


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


fixture = load("managed_rpc_fixture", "rm-0032-native-rpc.test.py")
base = fixture.rpc_module
idle = load("managed_idle_fixture", "rm-0032-native-epoch-rpc.py")
m = load("managed_lifetime_fixture", "rm-0032-native-epoch-managed-rpc.py")
base.NativeRpc = m.create_managed_rpc_class(base, idle)


class FakeRpc:
    def __init__(self): self.calls = []; self.cancelled = False; self.hook = lambda: None
    def cancel_requested(self): return self.cancelled
    def admit_model(self): self.calls.append(("admit",)); self.hook()
    def exchange(self, method, params, seconds):
        self.calls.append((method, params, seconds)); self.hook(); return ({}, None)
    def initialized(self, seconds): self.calls.append(("initialized", seconds)); self.hook()
    def next_frame(self, seconds): self.calls.append(("read", seconds)); self.hook(); return {"method": "x"}
    def respond(self, request_id, result, seconds): self.calls.append(("respond", request_id, result, seconds)); self.hook()


class VisualWriteTests(unittest.TestCase):
    def test_cancel_has_distinct_rpc_site_and_cannot_overwrite_prior_failure(self):
        for prior in (None,'deadline','read'):
            rpc=object.__new__(base.NativeRpc)
            rpc._closed=rpc._input_closed=False;rpc._phase='model';rpc._unknown=False
            rpc._failure={'code':'OK','site':'none','operation':'none','phase':'custody'}
            rpc._operation='next_frame';rpc._cancel=threading.Event();rpc._queue=[];rpc._buffer=bytearray()
            if prior is not None:
                with self.assertRaises(base.NativeRpcError):rpc._fail('TRANSPORT_UNKNOWN',True,prior)
            rpc.cancel()
            with self.assertRaises(base.NativeRpcError):rpc._check()
            self.assertEqual(rpc._failure['site'],prior or 'cancelled')
            self.assertEqual(rpc._failure['operation'],'next_frame')

    def test_sixteen_max_visual_writes_preserve_ordinary_budget_and_actual_serialization(self):
        import base64,tempfile
        raw=load('visual_raw_rpc','rm-0032-native-rpc.py')
        cls=m.create_managed_rpc_class(raw,idle);rpc=cls.__new__(cls)
        rpc._profile='image';rpc._reserved_writes=rpc._reserved_visual_writes=rpc._write_bytes=rpc._writes=0
        rpc._check=lambda:None;rpc._time=lambda _:None;rpc._wait=lambda *a,**k:True
        def fail(*args):raise raw.NativeRpcError(args[0])
        rpc._fail=fail
        image={'type':'image','url':'data:image/jpeg;base64,'+base64.b64encode(b'\xff\xd8\xff'+b'x'*(8*m.MIB-3)).decode()}
        frame={'id':'fixture','method':'turn/start','params':{'input':[{'type':'text','text':'Describe'},image]}}
        size=len(raw.encode_frame(frame,profile='image'));visual=m.visual_input_write_bytes(frame)
        with tempfile.TemporaryFile() as output:
            rpc._write_fd=output.fileno()
            for _ in range(16):
                output.seek(0);rpc._write(frame,100)
            self.assertEqual(rpc._writes,16);self.assertEqual(rpc._reserved_visual_writes,16*visual)
            self.assertEqual(rpc._reserved_writes,16*(size-visual));self.assertLess(rpc._reserved_writes,4096)
            output.seek(0);self.assertEqual(raw.decode_frame(output.read(),profile='image'),frame)
            rpc._reserved_visual_writes=m.VISUAL_WRITE_CAP-visual+1
            with self.assertRaises(raw.NativeRpcError):rpc._write(frame,100)
            self.assertEqual(rpc._writes,16)
            rpc._reserved_visual_writes=0;rpc._reserved_writes=m.RAW_WRITE_CAP-(size-visual)+1
            with self.assertRaises(raw.NativeRpcError):rpc._write(frame,100)
            self.assertEqual(rpc._writes,16)

    def test_foreign_image_shapes_and_nonimage_bytes_receive_no_visual_exemption(self):
        import base64,copy
        image={'type':'image','url':'data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n').decode()}
        frame={'id':'fixture','method':'turn/start','params':{'input':[{'type':'text','text':'x'},image]}}
        self.assertEqual(m.visual_input_write_bytes(frame),len(image['url']))
        for patch in ({'url':'https://example.invalid/image'},{'url':image['url']+' '},{'url':'data:image/jpeg;base64,AAAA'},{'detail':'high'},{'url':None}):
            value=copy.deepcopy(frame);value['params']['input'][1].update(patch)
            self.assertEqual(m.visual_input_write_bytes(value),0)
        for method in ('thread/start','item/completed','neurobro_send_image'):
            self.assertEqual(m.visual_input_write_bytes({**frame,'method':method}),0)
        self.assertEqual(m.visual_input_write_bytes({'method':'turn/start','params':{'input':[image]*3}}),0)
        self.assertEqual(m.visual_input_write_bytes({'method':'turn/start','params':{'input':[{'type':'text','text':image['url']}]}}),0)


class DeadlineTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0; self.rpc = FakeRpc()
        self.bound = m.ManagedDeadlineRpc(self.rpc, lambda: self.now)

    def start(self):
        self.bound.begin_epoch(); self.bound.exchange("thread/start", {}); self.bound.exchange("turn/start", {})

    def test_custody_deadline_then_one_epoch_transition(self):
        self.assertEqual(self.bound.remaining(300), 120)
        self.now += 110; self.bound.initialized()
        self.assertEqual(self.rpc.calls[-1], ("initialized", 10))
        self.bound.begin_epoch(); self.assertEqual(self.bound.deadline, 1020)
        with self.assertRaises(m.ManagedDeadlineError): self.bound.begin_epoch()
        self.assertEqual(self.rpc.calls.count(("admit",)), 1)
        self.now = 1019; self.assertEqual(self.bound.remaining(300), 1)
        self.now = 1020
        with self.assertRaises(m.ManagedDeadlineError): self.bound.remaining()

    def test_no_deadline_refresh_if_custody_admission_consumes_budget(self):
        self.rpc.hook = lambda: setattr(self, "now", 131)
        with self.assertRaises(m.ManagedDeadlineError): self.bound.begin_epoch()
        self.assertFalse(self.bound.epoch)
        self.assertEqual(self.bound.deadline, 130)

    def test_one_thread_sixteen_turns_and_no_custody_after_model(self):
        self.bound.begin_epoch(); self.bound.exchange("thread/start", {})
        for _ in range(16): self.bound.exchange("turn/start", {})
        before = len(self.rpc.calls)
        for method in ("turn/start", "thread/start", "account/read"):
            with self.assertRaises(m.ManagedDeadlineError): self.bound.exchange(method, {})
        self.assertEqual(len(self.rpc.calls), before)
        self.assertEqual(self.bound.counters(), {"threadStartDispatches": 1, "turnStartDispatches": 16})

    def test_turn_not_allowed_before_thread_or_epoch(self):
        with self.assertRaises(m.ManagedDeadlineError): self.bound.exchange("thread/start", {})
        self.bound.begin_epoch()
        with self.assertRaises(m.ManagedDeadlineError): self.bound.exchange("turn/start", {})
        self.assertEqual(self.bound.counters()["turnStartDispatches"], 0)

    def test_dispatch_remains_consumed_when_rpc_raises(self):
        self.bound.begin_epoch()
        def fail(): raise OSError("private")
        self.rpc.hook = fail
        with self.assertRaises(OSError): self.bound.exchange("thread/start", {})
        self.assertEqual(self.bound.counters()["threadStartDispatches"], 1)
        with self.assertRaises(m.ManagedDeadlineError): self.bound.exchange("thread/start", {})

    def test_exact_typed_successful_response_ledger_and_next_turn_reset(self):
        self.start()
        ids = (2**63 - 1, str(2**63 - 1), -(2**63))
        for request_id in ids: self.bound.respond(request_id, {"success": False}, 10)
        self.assertEqual(self.bound.response_ids(), ids)
        self.assertIs(type(self.bound.response_ids()[0]), int)
        self.bound.exchange("turn/start", {})
        self.assertEqual(self.bound.response_ids(), ())

    def test_failed_response_excluded_but_successful_late_response_retained(self):
        self.start()
        def fail(): raise OSError("private")
        self.rpc.hook = fail
        with self.assertRaises(OSError): self.bound.respond("failed", {}, 10)
        self.assertEqual(self.bound.response_ids(), ())
        self.rpc.hook = lambda: setattr(self, "now", 1000)
        with self.assertRaises(m.ManagedDeadlineError): self.bound.respond("written", {}, 10)
        self.assertEqual(self.bound.response_ids(), ("written",))

    def test_cancelled_and_invalid_calls_do_not_dispatch(self):
        for value in (0, -1, True, float("inf"), float("nan"), "10"):
            with self.assertRaises(m.ManagedDeadlineError): self.bound.remaining(value)
        self.rpc.cancelled = True
        with self.assertRaises(m.ManagedDeadlineError): self.bound.exchange("initialize", {})
        self.assertEqual(self.rpc.calls, [])


@unittest.skipUnless(sys.platform == "linux", "Actual anonymous pipes require Linux selectors")
class PipeTests(unittest.TestCase):
    def peer(self): return fixture.Peer(self, profile="image")

    def wait_then_cancel(self, rpc, call):
        results = []; started = threading.Event()
        def run():
            started.set()
            try: results.append(call())
            except base.NativeRpcError as error: results.append(error.code)
        worker = threading.Thread(target=run); worker.start(); self.assertTrue(started.wait(1))
        time.sleep(.04); before = time.monotonic(); rpc.cancel(); rpc.cancel()
        worker.join(1.2)
        self.assertFalse(worker.is_alive(), "cancel failed to join actual RPC call")
        self.assertLess(time.monotonic() - before, 1.2)
        self.assertEqual(results, ["TRANSPORT_UNKNOWN"])
        self.assertFalse(rpc.metadata()["inputClosed"])
        self.assertFalse(rpc.metadata()["closed"])
        self.assertTrue(rpc.epoch_metadata()["cancelRequested"])

    def test_cancel_interrupts_three_hundred_second_read_without_closing_pipe(self):
        with self.peer() as p:
            p.initialize(); self.wait_then_cancel(p.rpc, lambda: p.rpc.next_frame(300))
            p.rpc.close_input(); p.server_out.close()
            self.assertTrue(p.rpc.drain_to_eof(.5))
            self.assertTrue(p.rpc.metadata()["stdoutEofObserved"])

    def test_cancel_interrupts_backpressured_partially_written_request(self):
        with self.peer() as p:
            p.initialize()
            self.wait_then_cancel(p.rpc, lambda: p.rpc.exchange("turn/start", {"text": "x" * (2*m.MIB)}, 300))
            written = p.rpc.metadata()["bytesWritten"]
            self.assertGreater(written, 0)
            self.assertLess(written, 2*m.MIB)
            time.sleep(.06); self.assertEqual(p.rpc.metadata()["bytesWritten"], written)
            self.assertGreater(p.rpc.epoch_metadata()["reservedWriteBytes"], written)

    def test_cancel_interrupts_idle_poll_and_stays_revoked(self):
        with self.peer() as p:
            p.initialize(); self.wait_then_cancel(p.rpc, lambda: p.rpc.poll_frame(1))
            with self.assertRaises(base.NativeRpcError): p.rpc.next_frame(1)

    def test_read_crossing_budget_is_never_delivered(self):
        with self.peer() as p:
            p.initialize(); frame = {"method": "skills/changed", "params": {}}
            raw = base.encode_frame(frame)
            cap = p.rpc.metadata()["bytesRead"] + len(raw) - 1
            with mock.patch.object(m, "RAW_READ_CAP", cap):
                p.send(frame)
                with self.assertRaises(base.NativeRpcError) as caught: p.rpc.next_frame(1)
                self.assertEqual(caught.exception.code, "BOUNDS_REFUSED")
                self.assertEqual(p.rpc.metadata()["queuedFrames"], 0)
                self.assertLessEqual(p.rpc.metadata()["bytesRead"], cap + 65536)

    def test_write_reservation_rejects_before_any_new_bytes(self):
        with self.peer() as p:
            p.initialize(); before = p.rpc.metadata()["bytesWritten"]
            with mock.patch.object(m, "RAW_WRITE_CAP", p.rpc.epoch_metadata()["reservedWriteBytes"]):
                with self.assertRaises(base.NativeRpcError): p.rpc.exchange("thread/start", {}, 1)
            self.assertEqual(p.rpc.metadata()["bytesWritten"], before)

    def test_cleanup_flood_is_bounded_and_does_not_claim_eof(self):
        with self.peer() as p:
            p.initialize(); p.rpc.cancel(); p.rpc.close_input()
            os.write(p.server_out.fileno(), b"x" * 128); p.server_out.close()
            with mock.patch.object(m, "CLEANUP_READ_CAP", 64):
                self.assertFalse(p.rpc.drain_to_eof(.5))
            self.assertEqual(p.rpc.metadata()["shutdownDiscardedBytes"], 64)
            self.assertFalse(p.rpc.metadata()["stdoutEofObserved"])
            with self.assertRaises(base.NativeRpcError): p.rpc.drain_to_eof(.5)
            self.assertEqual(p.rpc.metadata()["shutdownDiscardedBytes"], 64)
            self.assertTrue(p.rpc.epoch_metadata()["cleanupConsumed"])

    def test_exact_id_request_respond_and_parser_remain_canonical(self):
        with self.peer() as p:
            p.initialize(); frame = {"id": 2**63 - 1, "method": "item/tool/call", "params": {}}
            p.send(frame); self.assertEqual(p.rpc.poll_frame(.5), frame)
            p.rpc.respond(frame["id"], {"success": False}, .5)
            self.assertEqual(p.receive(), {"id": frame["id"], "result": {"success": False}})
            self.assertEqual(p.rpc.metadata()["frameCap"], 12*m.MIB)
            self.assertEqual(p.rpc.metadata()["queueByteCap"], 32*m.MIB)


if __name__ == "__main__": unittest.main()
