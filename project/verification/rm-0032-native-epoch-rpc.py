"""Source-only warm-epoch idle extension over a caller-pinned NativeRpc module.

Does not change the historical parser, profiles, queue caps, next_frame or
process ownership. This factory does not verify source pins or custody itself;
trusted composition must validate the base and extension before construction.
The returned subclass inherits the exact sole reader, pipe handles and lock.
"""
import math
import selectors
import time

IDLE = object()
IDLE_POLL_SECONDS = 1.0


def create_epoch_rpc_class(base):
    NativeRpcError = base.NativeRpcError

    class EpochRpc(base.NativeRpc):
        def poll_frame(self, seconds=0.0):
            """Return one envelope or IDLE without poisoning an ordinary idle wait.

            Same sole pipe reader/lock and request accounting as next_frame. A zero
            budget checks the queue then performs at most one nonblocking read;
            positive budgets wait at most one second for a complete frame. Partial
            bytes are retained. IDLE is not proof of an empty channel: idle_state()
            exposes already-observed partial/queued/pending work, and future bytes
            can still arrive. The owner must validate every returned method against
            its exact lifecycle, including late requests, refusals and compaction.
            No automatic response, semantic event discard or process claim occurs.
            EOF/invalid frames/read errors remain fatal exactly as next_frame.
            """
            # Shared receive diagnostic category; existing metadata schema unchanged.
            self._operation = "next_frame"
            self._enter()
            try:
                if self._phase != "model": self._fail("PHASE_REFUSED")
                if type(seconds) not in (int, float) or not 0 <= seconds <= IDLE_POLL_SECONDS or not math.isfinite(seconds):
                    self._fail("BOUNDS_REFUSED")
                deadline, attempted = time.monotonic() + seconds, False
                with selectors.DefaultSelector() as selector:
                    selector.register(self._read_fd, selectors.EVENT_READ)
                    while True:
                        self._check()
                        if self._eof: self._fail("TRANSPORT_UNKNOWN", True, "eof")
                        # Parsing a large readable frame may itself consume the
                        # positive poll budget. Keep it queued for the next call.
                        if seconds > 0 and time.monotonic() >= deadline: return IDLE
                        if self._queue:
                            frame, size = self._queue.popleft(); self._queued_bytes -= size
                            if "method" not in frame: self._fail("PROTOCOL_REFUSED", True)
                            if "id" in frame:
                                key = (type(frame["id"]), frame["id"])
                                if self._pending.get(key) != "queued": self._fail("PROTOCOL_REFUSED", True)
                                self._pending[key] = "delivered"
                            return frame
                        remaining = max(0.0, deadline - time.monotonic())
                        if attempted and remaining <= 0: return IDLE
                        ready = selector.select(remaining)
                        self._check()
                        # A delayed scheduler/selector must not turn an expired
                        # positive idle budget into fresh reads or delivery.
                        # Keep all queued/partial state untouched for next poll.
                        if seconds > 0 and time.monotonic() >= deadline: return IDLE
                        if not ready: return IDLE
                        self._ingest()
                        attempted = True
            except NativeRpcError: raise
            except Exception: self._fail("TRANSPORT_UNKNOWN", True, "selector")
            finally: self._lock.release()

        def idle_state(self):
            """Observed receive state only; never certifies no future late events.

            Same nonconcurrent lock contract as all RPC operations. No reads or
            selector work. Separate from the historical fixed metadata schema.
            """
            self._operation = "next_frame"
            self._enter()
            try:
                if self._phase != "model": self._fail("PHASE_REFUSED")
                return {"partialBytes": len(self._buffer), "queuedFrames": len(self._queue),
                        "pendingRequests": len(self._pending), "stdoutEofObserved": self._eof}
            finally: self._lock.release()

    return EpochRpc
