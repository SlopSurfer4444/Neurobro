"""Portable canonical codec cases; Linux anonymous pipes only for I/O cases."""
import importlib.util
import os
from pathlib import Path
import select
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("epoch_wire",Path(__file__).with_name("rm-0032-native-epoch-wire.py"))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
IDLE=object()

def write_all(fd,data,seconds=2):
    os.set_blocking(fd,False);end=time.monotonic()+seconds;offset=0
    while offset<len(data):
        if time.monotonic()>=end:raise AssertionError("fixture writer deadline")
        try:offset+=os.write(fd,data[offset:])
        except BlockingIOError:select.select([],[fd],[],.005)

def read_exact(fd,length,seconds=2):
    os.set_blocking(fd,False);end=time.monotonic()+seconds;data=bytearray()
    while len(data)<length:
        if time.monotonic()>=end:raise AssertionError("fixture reader deadline")
        try:
            chunk=os.read(fd,length-len(data))
            if not chunk:raise AssertionError("fixture unexpected EOF")
            data.extend(chunk)
        except BlockingIOError:select.select([fd],[],[],.005)
    return bytes(data)

class VisualCodecTests(unittest.TestCase):
    def test_large_visual_frame_is_input_only_and_other_frame_caps_remain(self):
        frame={"kind":"turn","requestRef":"photo","conversation":"Describe","images":[{"mimeType":"image/png","base64":"A"*(11*1024*1024)}]}
        encoded=m.encode_frame(frame,incoming=True)
        self.assertEqual(m.decode_frame(encoded),frame)
        with self.assertRaises(m.EpochWireError):m.encode_frame(frame)
        for kind in ("completed","toolResult"):
            with self.assertRaises(m.EpochWireError):m.encode_frame({**frame,"kind":kind},incoming=True)
        with self.assertRaises(m.EpochWireError):m.encode_frame({**frame,"images":"A"*(12*1024*1024)},incoming=True)

class Pipes:
    def __enter__(self):
        self.read,self.peer_write=os.pipe();self.peer_read,self.write=os.pipe()
        self.fds={self.read,self.peer_write,self.peer_read,self.write}
        self.wire=m.NativeEpochWire(self.read,self.write,idle=IDLE)
        self.threads=[];self.errors=[];return self
    def start(self,call):
        def task():
            try:call()
            except BaseException as error:self.errors.append(error)
        thread=threading.Thread(target=task);self.threads.append(thread);thread.start();return thread
    def close_fd(self,fd):os.close(fd);self.fds.remove(fd)
    def __exit__(self,kind,value,tb):
        self.wire.close()
        for thread in self.threads:thread.join(2.2)
        alive=any(thread.is_alive() for thread in self.threads)
        for fd in self.fds:os.close(fd)
        if alive:raise AssertionError("fixture worker not joined")
        if kind is None and self.errors:raise self.errors[0]

class CodecTests(unittest.TestCase):
    def test_canonical_js_key_order_utf8_and_controls(self):
        value={"z":"🤝\u2028\x01","10":"ten","2":"two","01":"literal","a":[None,True,-5]}
        encoded=m.encode_frame(value)
        self.assertEqual(encoded,'{"2":"two","10":"ten","z":"🤝\u2028\\u0001","01":"literal","a":[null,true,-5]}\n'.encode())
        self.assertEqual(m.decode_frame(encoded),value)
    def test_duplicate_noncanonical_invalid_unicode_and_numeric_values_refused(self):
        cases=[b'{"x":1,"x":2}\n',b'{"x": 1}\n',b'{}\r\n',b'{"x":"\\u0061"}\n',b'[]\n',b'{"x":1.25}\n',b'{"x":NaN}\n',b'{"x":9007199254740992}\n',b'{"x":"\\ud800"}\n',b'{"x":"\xff"}\n',b'{"x":-0}\n',b'{"2":0,"1":0}\n']
        for data in cases:
            with self.subTest(data=cases.index(data)),self.assertRaises(m.EpochWireError) as error:m.decode_frame(data)
            self.assertEqual(str(error.exception),"EPOCH_WIRE_FRAME")
        for value in ({"x":1.5},{"x":2**63-1},{"x":"\ud800"},{1:"x"}):
            with self.assertRaises(m.EpochWireError):m.encode_frame(value)
    def test_exact_frame_ceiling_excludes_lf(self):
        data=m.encode_frame({"x":"a"*(m.FRAME_BYTES-8)})
        self.assertEqual(len(data),m.FRAME_BYTES+1);self.assertEqual(len(m.decode_frame(data)["x"]),m.FRAME_BYTES-8)
        with self.assertRaises(m.EpochWireError):m.encode_frame({"x":"a"*(m.FRAME_BYTES-7)})

@unittest.skipUnless(sys.platform=="linux","requires Linux nonblocking anonymous pipes")
class PipeTests(unittest.TestCase):
    def test_selector_construction_and_exit_faults_are_fixed_terminal_errors(self):
        for direction in ("read", "write"):
            for when in ("construct", "exit"):
                with self.subTest(direction=direction, when=when), Pipes() as p:
                    factory=m.selectors.DefaultSelector
                    class ExitFailure:
                        def __enter__(self): self.selector=factory();return self.selector
                        def __exit__(self,*args): self.selector.close();raise OSError("private selector detail")
                    if direction=="read":os.write(p.peer_write,b'{}\n')
                    replacement=mock.Mock(side_effect=OSError("private selector detail")) if when=="construct" else ExitFailure
                    with mock.patch.object(m.selectors,"DefaultSelector",replacement):
                        with self.assertRaises(m.EpochWireError) as error:
                            p.wire.receive(.2) if direction=="read" else p.wire.emit({},.2)
                    self.assertEqual(error.exception.code,direction);self.assertTrue(error.exception.unknown)
                    self.assertNotIn("private",str(error.exception));self.assertEqual(p.wire.metadata()["code"],direction)
                    with self.assertRaises(m.EpochWireError):p.wire.receive(.2)

    def test_observed_eof_survives_read_deadline_and_decode_idle_keeps_frame(self):
        for partial in (b'',b'{"unfinished":'):
            with self.subTest(partial=bool(partial)),Pipes() as p:
                if partial:os.write(p.peer_write,partial)
                p.close_fd(p.peer_write)
                now=[0.0];original=os.read
                def delayed_eof(fd,length):
                    data=original(fd,length)
                    if data==b'':now[0]=2.0
                    return data
                with patch.object(m.time,"monotonic",side_effect=lambda:now[0]),patch.object(m.os,"read",side_effect=delayed_eof):
                    if partial:
                        with self.assertRaises(m.EpochWireError) as error:p.wire.receive(.1)
                        self.assertEqual(error.exception.code,"partial-eof")
                    else:self.assertIsNone(p.wire.receive(.1))
                self.assertTrue(p.wire.metadata()["eof"])
        with Pipes() as p:
            os.write(p.peer_write,b'{"kind":"close"}\n');now=[0.0];original=m.decode_frame
            def delayed_decode(line):
                value=original(line);now[0]=2.0;return value
            with patch.object(m.time,"monotonic",side_effect=lambda:now[0]),patch.object(m,"decode_frame",side_effect=delayed_decode):
                self.assertIs(p.wire.receive(.1),IDLE)
            self.assertEqual(p.wire.metadata()["framesRead"],0)
            self.assertEqual(p.wire.receive(.2),{"kind":"close"})
    def test_idle_preserves_split_utf8_and_multiple_frames_then_clean_eof(self):
        with Pipes() as p:
            data=m.encode_frame({"text":"Привет 🤝"})
            split=data.index("🤝".encode())+2
            os.write(p.peer_write,data[:split]);self.assertIs(p.wire.receive(.02),IDLE)
            os.write(p.peer_write,data[split:]+b'{"kind":"close"}\n')
            self.assertEqual(p.wire.receive(.2),{"text":"Привет 🤝"})
            self.assertEqual(p.wire.receive(.2),{"kind":"close"})
            p.close_fd(p.peer_write);self.assertIsNone(p.wire.receive(.2))
            self.assertIsNone(p.wire.receive(.2));self.assertFalse(p.wire.metadata()["resourceSettlementObserved"])
    def test_partial_eof_poison_and_no_raw_error(self):
        with Pipes() as p:
            os.write(p.peer_write,b'{"private":"secret');p.close_fd(p.peer_write)
            with self.assertRaises(m.EpochWireError) as error:p.wire.receive(.2)
            self.assertEqual(error.exception.code,"partial-eof");self.assertTrue(error.exception.unknown)
            self.assertNotIn("secret",repr(error.exception));self.assertEqual(p.wire._buffer,bytearray())
            with self.assertRaises(m.EpochWireError):p.wire.emit({"x":1},.2)
    def test_bad_frame_poison_before_later_valid_frame(self):
        with Pipes() as p:
            os.write(p.peer_write,b'{"x":1,"x":2}\n{}\n')
            with self.assertRaises(m.EpochWireError):p.wire.receive(.2)
            with self.assertRaises(m.EpochWireError):p.wire.receive(.2)
            self.assertEqual(p.wire.metadata()["framesRead"],0)
    def test_parallel_directions_real_large_pipe_frames(self):
        with Pipes() as p:
            value={"text":"x"*200000};encoded=m.encode_frame(value);output=[]
            p.start(lambda:write_all(p.peer_write,encoded))
            p.start(lambda:output.append(read_exact(p.peer_read,len(encoded))))
            written=[];thread=p.start(lambda:written.append(p.wire.emit(value,1)))
            self.assertEqual(p.wire.receive(1),value);thread.join(1)
            self.assertEqual(written,[True])
            for worker in p.threads:worker.join(1)
            self.assertEqual(output,[encoded]);self.assertEqual(p.wire.metadata()["framesWritten"],1)
    def test_backpressure_deadline_partial_unknown_no_background_writer(self):
        with Pipes() as p:
            start=time.monotonic()
            with self.assertRaises(m.EpochWireError) as error:p.wire.emit({"text":"p"*200000},.03)
            self.assertEqual(error.exception.code,"write-timeout");self.assertTrue(error.exception.unknown)
            self.assertLess(time.monotonic()-start,.3)
            count=p.wire.metadata()["bytesWritten"];self.assertGreater(count,0)
            self.assertEqual(len(read_exact(p.peer_read,count)),count)
            with self.assertRaises(BlockingIOError):os.read(p.peer_read,1)
            with self.assertRaises(m.EpochWireError):p.wire.emit({"retry":True},.2)
            self.assertEqual(p.wire.metadata()["bytesWritten"],count)
    def test_close_interrupts_read_and_write_leaves_descriptors_owned(self):
        with Pipes() as p:
            errors=[]
            def operation(call):
                try:call()
                except m.EpochWireError as error:errors.append(error.code)
            p.start(lambda:operation(lambda:p.wire.receive(1)))
            p.start(lambda:operation(lambda:p.wire.emit({"text":"x"*200000},20)))
            end=time.monotonic()+1
            while not (p.wire._reader.locked() and p.wire._write_active):
                if time.monotonic()>end:self.fail("workers not entered")
                time.sleep(.001)
            with self.assertRaises(m.EpochWireError) as error:p.wire.emit({},.1)
            self.assertEqual(error.exception.code,"concurrent-write")
            start=time.monotonic();p.wire.close()
            for thread in p.threads:thread.join(.3)
            self.assertLess(time.monotonic()-start,.3);self.assertEqual(sorted(errors),["closed","closed"])
            self.assertTrue(p.wire.metadata()["unknown"])
            os.fstat(p.read);os.fstat(p.write)
    def test_deadline_after_final_write_remains_consumed_unknown(self):
        with Pipes() as p:
            original=os.write
            def write_then_expire(fd,data):
                count=original(fd,data);time.sleep(.02);return count
            os.write=write_then_expire
            try:
                with self.assertRaises(m.EpochWireError) as error:p.wire.emit({"x":1},.005)
            finally:os.write=original
            self.assertEqual(error.exception.code,"write-timeout");self.assertTrue(error.exception.unknown)
            self.assertEqual(p.wire.metadata()["framesWritten"],0)
            self.assertEqual(read_exact(p.peer_read,8),b'{"x":1}\n')
            with self.assertRaises(m.EpochWireError):p.wire.emit({"retry":1},.2)
    def test_concurrent_same_direction_and_timeout_values_rejected(self):
        with Pipes() as p:
            for value in (True,0,-1,1.001,float("nan"),float("inf")):
                with self.assertRaises(m.EpochWireError) as error:p.wire.receive(value)
                self.assertEqual(error.exception.code,"timeout-value")
            for value in (True,20.001,float("inf")):
                with self.assertRaises(m.EpochWireError):p.wire.emit({},value)
            reader=p.start(lambda:self.assertIs(p.wire.receive(.1),IDLE))
            end=time.monotonic()+.5
            while not p.wire._reader.locked():
                if time.monotonic()>end:self.fail("reader did not start")
                time.sleep(.001)
            with self.assertRaises(m.EpochWireError) as error:p.wire.receive(.1)
            self.assertEqual(error.exception.code,"concurrent-read")
            reader.join(.3);self.assertFalse(reader.is_alive())
    def test_epoch_totals_and_oversized_unterminated_frame(self):
        with Pipes() as p:
            p.wire._reserved_bytes=m.TOTAL_BYTES-3
            self.assertTrue(p.wire.emit({},.2))
            with self.assertRaises(m.EpochWireError) as error:p.wire.emit({},.2)
            self.assertEqual(error.exception.code,"bounds");self.assertEqual(read_exact(p.peer_read,3),b'{}\n')
        with Pipes() as p:
            p.wire._read_bytes=m.TOTAL_BYTES-3;os.write(p.peer_write,b'{}\n')
            self.assertEqual(p.wire.receive(.2),{})
            os.write(p.peer_write,b'{}\n')
            with self.assertRaises(m.EpochWireError):p.wire.receive(.2)
        with Pipes() as p:
            p.start(lambda:write_all(p.peer_write,b'x'*(m.FRAME_BYTES+1)))
            with self.assertRaises(m.EpochWireError) as error:p.wire.receive(1)
            self.assertEqual(error.exception.code,"bounds")
    def test_regular_files_reversed_ends_and_noninteger_fd_refused(self):
        with tempfile.TemporaryFile() as regular,Pipes() as p:
            for read,write in ((regular.fileno(),p.write),(p.read,regular.fileno()),(p.peer_write,p.write),(p.read,p.peer_read),(True,p.write)):
                with self.assertRaises(m.EpochWireError) as error:m.NativeEpochWire(read,write,idle=IDLE)
                self.assertEqual(error.exception.code,"config")

if __name__=="__main__":unittest.main()
