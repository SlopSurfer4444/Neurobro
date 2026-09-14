"""Opt-in one-image native turn. Pure loaded-module composition; no I/O.

Root pins both supplied modules and the canary source before construction. RPC
must separately enforce the admitted 12 MiB frame limit and hard deadlines.
Default NativeConversation is unchanged. Caption is model text, never a delivery
receipt. No savedPath is opened and no model-selected path is exported.
"""
import json
import threading

IMAGE_FRAME_BYTES = 12 * 1024 * 1024
IMAGE_LIFECYCLE_BYTES = 48 * 1024 * 1024
IMAGE_WORK_SECONDS = 300.0
FAILURES = frozenset({"none", "scope", "png", "base64", "size", "item", "status", "failure", "multiple-images", "budget", "conflict", "envelope", "correlation", "lifecycle", "shape", "revoked", "turn-failed", "missing-terminal", "not-ready", "image-required"})


def create_native_image_conversation(native_module, collector_module, canary_source, *, request_ref, **kwargs):
    """Trusted modules loaded by the owning source-pinned capsule. One run only.

    Return has run(prompt), state(), image_artifact(), image_frames(), close().
    run preserves answer/metadata and adds imageMetadata, without artifact bytes.
    Export requires exact native completion, lifecycle checks and one image.
    """
    n, c = native_module, collector_module
    n.require(c.identifier(request_ref), "CONFIG_REFUSED", "config")

    class NativeImageConversation(n.NativeConversation):
        def __init__(self):
            super().__init__(canary_source, **kwargs)
            self._images = None
            self._image_ready = self._image_used = self._image_closed = False
            self._image_failure = "none"
            self._image_wire = self._image_ack_ordinary = 0
            self._image_lock = threading.Lock()
            base_observer = self._observer

            class ImageObserver(base_observer):
                def item(observer, item, completed):
                    if type(item) is dict and item.get("type") == "imageGeneration":
                        # Raw lifecycle was already validated by _exchange or
                        # _count_frame, before any ordinary projection stripped
                        # result. Never count/decode the same evidence twice.
                        n.require(self._images is not None, site="item")
                        return
                    return super().item(item, completed)

                def turn(observer, turn, completed):
                    super().turn(turn, completed)
                    if completed:
                        self._collect(lambda: self._images.finish_turn(thread_id=self._thread, turn_id=observer.turn_id, status=turn["status"]))

            self._observer = ImageObserver

        def _turn_deadline(self):
            return self._clock() + IMAGE_WORK_SECONDS

        def _remaining(self, deadline):
            n.require(not self._image_closed, "TRANSPORT_UNKNOWN", "deadline")
            return super()._remaining(deadline)

        def _collect(self, call):
            try:
                return call()
            except c.ImageCollectorError as error:
                self._image_failure = error.code if error.code in FAILURES else "shape"
                raise n.Refused("BOUNDS_REFUSED" if self._image_failure in {"size", "budget"} else "PROTOCOL_REFUSED", "events") from None

        def _project(self, frame, items):
            raw = n.encoded(frame)
            n.require(len(raw) <= IMAGE_FRAME_BYTES, "BOUNDS_REFUSED", "events")
            images = [item for item in items if type(item) is dict and item.get("type") == "imageGeneration"]
            if images:
                self._image_wire = min(IMAGE_LIFECYCLE_BYTES + 1, self._image_wire + len(raw))
                n.require(self._image_wire <= IMAGE_LIFECYCLE_BYTES, "BOUNDS_REFUSED", "events")
            ordinary = json.loads(raw)
            if not images:
                return ordinary
            # Caller has already fed each original image to the collector.
            # Keep every envelope/metadata/unknown field under ordinary limits.
            def strip(value):
                if type(value) is dict and value.get("type") == "imageGeneration": value["result"] = ""
            if "method" not in frame:
                for item in ordinary.get("turn", {}).get("items", []): strip(item)
            else:
                p = ordinary.get("params")
                if type(p) is dict:
                    if frame.get("method") in {"item/started", "item/completed"}: strip(p.get("item"))
                    elif frame.get("method") in {"turn/started", "turn/completed"} and type(p.get("turn")) is dict:
                        for item in p["turn"].get("items", []): strip(item)
            return ordinary

        def _exchange(self, method, params, deadline):
            if method != "turn/start": return super()._exchange(method, params, deadline)
            reply = self._rpc.exchange(method, params, min(20.0, self._remaining(deadline)))
            self._remaining(deadline)
            n.require(type(reply) is tuple and len(reply) == 2, site="exchange")
            result, error = reply
            n.require(error is None, "TURN_REFUSED", "exchange")
            n.require(type(result) is dict and len(n.encoded(result)) <= IMAGE_FRAME_BYTES, site="exchange")
            turn = result.get("turn")
            n.require(type(turn) is dict and self._reviewed.opaque_id(turn.get("id")) and turn["id"] not in self._turn_ids
                      and type(turn.get("items")) is list and len(turn["items"]) <= n.EVENT_CAP, site="turn_ack")
            self._images = c.NativeImageCollector({"requestRef": request_ref, "threadId": self._thread, "turnId": turn["id"]})
            for item in turn["items"]:
                if type(item) is dict and item.get("type") == "imageGeneration":
                    self._collect(lambda item=item: self._images.observe_snapshot(item, thread_id=self._thread, turn_id=turn["id"]))
            ordinary = self._project(result, turn["items"])
            self._image_ack_ordinary = len(n.encoded(ordinary))
            n.require(self._image_ack_ordinary <= n.EVENT_BYTES_CAP, "BOUNDS_REFUSED", "exchange")
            return result

        def _count_frame(self, frame, receipt):
            n.require(type(frame) is dict and len(n.encoded(frame)) <= IMAGE_FRAME_BYTES, "BOUNDS_REFUSED", "events")
            method, params = frame.get("method"), frame.get("params")
            items = []
            if type(params) is dict and "id" not in frame:
                if method in {"item/started", "item/completed"}:
                    items = [params.get("item")]
                    if type(items[0]) is dict and items[0].get("type") == "imageGeneration":
                        self._collect(lambda: self._images.observe_notification(frame))
                elif method in {"turn/started", "turn/completed"} and type(params.get("turn")) is dict:
                    turn = params["turn"]
                    n.require(type(turn.get("items")) is list and len(turn["items"]) <= n.EVENT_CAP, site="turn")
                    items = turn["items"]
                    for item in items:
                        if type(item) is dict and item.get("type") == "imageGeneration":
                            self._collect(lambda item=item: self._images.observe_snapshot(item, thread_id=params.get("threadId"), turn_id=turn.get("id")))
            ordinary = self._project(frame, items)
            receipt["eventBytes"] += self._image_ack_ordinary
            self._image_ack_ordinary = 0
            return super()._count_frame(ordinary, receipt)

        def _image_metadata(self):
            value = self._images.metadata() if self._images is not None else {"outcome": "not-requested", "started": False, "completed": False, "evidenceCount": 0, "imageLifecycleBytes": 0, "failureCode": "none"}
            return {**value, "rawImageLifecycleBytes": self._image_wire, "failureSite": self._image_failure,
                    "exportReady": self._image_ready and not self._image_closed and not self._poisoned}

        def run(self, text):
            if not self._image_lock.acquire(blocking=False):
                receipt = n.metadata(); receipt["code"] = "BUSY"
                return {"answer": None, "metadata": receipt, "imageMetadata": self._image_metadata()}
            try:
                if self._image_used or self._image_closed:
                    receipt = n.metadata(); receipt["code"] = "SESSION_LIMIT"; receipt["sessionPoisoned"] = self._poisoned
                    return {"answer": None, "metadata": receipt, "imageMetadata": self._image_metadata()}
                self._image_used = True
                result = super().run(text)
                if result["metadata"]["outcome"] == "observed" and not self._poisoned:
                    if self._images is not None and self._images.metadata()["outcome"] == "completed":
                        self._image_ready = True
                    else:
                        self._image_failure = "image-required"
                        self._poisoned = True
                        result["answer"] = None
                        result["metadata"].update(outcome="unknown", code="ANSWER_REFUSED", failureSite="answer_missing", sessionPoisoned=True)
                if not self._image_ready:
                    if self._images is not None: self._images.close()
                return {**result, "imageMetadata": self._image_metadata()}
            finally:
                self._image_lock.release()

        def image_artifact(self):
            n.require(self._image_ready and not self._image_closed and not self._poisoned and not self._image_lock.locked(), "ANSWER_REFUSED", "answer_missing")
            return self._images.artifact_record()

        def image_frames(self):
            self.image_artifact()
            for frame in self._images.artifact_frames():
                n.require(self._image_ready and not self._image_closed and not self._poisoned, "ANSWER_REFUSED", "answer_missing")
                yield frame

        def close(self):
            self._image_closed = True
            self._image_ready = False
            if self._images is not None: self._images.close()

    return NativeImageConversation()
