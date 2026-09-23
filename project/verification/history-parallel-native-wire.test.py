"""Actual anonymous-pipe multiplex visual frame, no processes or network."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import threading
import unittest

spec=importlib.util.spec_from_file_location('parallel_wire',Path(__file__).with_name('rm-0032-native-epoch-wire.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class CodecTests(unittest.TestCase):
    def test_only_explicit_parallel_foreground_images_receive_existing_large_cap(self):
        frame={'workerId':'worker-0','frame':{'kind':'turn','purpose':'conversation','requestRef':'photo','input':'photo','images':['x'*4000000]}}
        raw=m.encode_frame(frame,incoming=True,parallel=True)
        self.assertEqual(m.decode_frame(raw,parallel=True),frame)
        with self.assertRaises(m.EpochWireError):m.decode_frame(raw)
        for invalid in ({**frame,'work':{}},{**frame,'frame':{**frame['frame'],'purpose':'history-analysis'}},
                        {'workerId':'worker-0','frame':{'kind':'toolResult','result':'x'*4000000}}):
            with self.assertRaises(m.EpochWireError):m.encode_frame(invalid,incoming=True,parallel=True)
        with self.assertRaises(m.EpochWireError):m.encode_frame(frame,parallel=True)


@unittest.skipUnless(sys.platform=='linux','Real anonymous pipe selector requires Linux')
class PipeTests(unittest.TestCase):
    def test_real_reader_keeps_large_multiplex_foreground_frame_and_next_frame(self):
        read_fd,send_fd=os.pipe();sink_fd,write_fd=os.pipe()
        frame={'workerId':'worker-0','frame':{'kind':'turn','purpose':'conversation','requestRef':'photo','input':'photo','images':['x'*4000000]}}
        tail={'kind':'close'};data=m.encode_frame(frame,incoming=True,parallel=True)+m.encode_frame(tail)
        errors=[]
        def send():
            try:
                offset=0
                while offset<len(data):offset+=os.write(send_fd,data[offset:])
            except Exception as error:errors.append(error)
            finally:os.close(send_fd)
        wire=m.NativeEpochWire(read_fd,write_fd,idle=object(),parallel=True)
        thread=threading.Thread(target=send);thread.start()
        try:
            self.assertEqual(wire.receive(1),frame)
            self.assertEqual(wire.receive(1),tail)
        finally:
            thread.join(3);wire.close()
            for fd in (read_fd,write_fd,sink_fd):os.close(fd)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[])


if __name__=='__main__':unittest.main()
