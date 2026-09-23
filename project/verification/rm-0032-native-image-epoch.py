import base64
"""Bounded image/text/history epoch over an already admitted native RPC.

Pure composition: no launch, pipe ownership, file read, network, or OS settlement.
The controller pins supplied modules, owns custody, and supplies hard-deadline RPC
and tool ports. A completed turn is not process settlement or Telegram delivery.
Image lifecycle validation follows the reviewed one-shot adapter; the underlying
NativeConversation supplies thread reuse and native tool/response correlation.
"""
import json
import math
import threading

IMAGE_FRAME_BYTES = 12 * 1024 * 1024
IMAGE_LIFECYCLE_BYTES = 48 * 1024 * 1024
INPUT_ECHO_LIFECYCLE_BYTES = 64 * 1024 * 1024
TURN_SECONDS, EPOCH_SECONDS, EPOCH_TURNS = 300.0, 900.0, 16
DELIVERIES = frozenset({"verified", "not-sent", "unknown"})
FAILURES = frozenset({"none", "scope", "png", "base64", "size", "item", "status", "failure", "multiple-images", "budget", "conflict", "envelope", "correlation", "lifecycle", "shape", "revoked", "turn-failed", "missing-terminal", "not-ready", "image-required"})

class EpochError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__("native-epoch-" + code)


def create_native_image_epoch(native_module, collector_module, canary_source, **kwargs):
    """turn(request_ref,text) -> answer/metadata/imageMetadata/epochMetadata.

    releaseTurn(request_ref,delivery) releases only that completed turn; unknown
    delivery poisons the epoch. close() revokes admissions/exports; the caller
    must cancel and join its RPC/process. close() performs no RPC cancellation.
    The caller must serialize private artifact writes and check its own STOP fence.
    """
    n, c = native_module, collector_module

    class NativeImageEpoch(n.NativeConversation):
        def __init__(self):
            super().__init__(canary_source, **kwargs)
            self._state_lock = threading.RLock()
            self._epoch_started = self._now()
            self._epoch_deadline = self._epoch_started + EPOCH_SECONDS
            self._turn_seconds = 30.0 if self._isolation_mode == "community-assessment" else TURN_SECONDS
            self._admitted_deadline = None
            self._attempts = 0
            self._request_ref = None
            self._active_turn_id = None
            self._seen_refs = set()
            self._running = self._awaiting_release = self._image_closed = False
            self._images = None
            self._image_ready = False
            self._image_failure = "none"
            self._image_wire = self._image_ack_ordinary = 0
            self._generation = 0
            base_observer = self._observer

            class ImageObserver(base_observer):
                def item(observer, item, completed):
                    if type(item) is dict and item.get("type") == "imageGeneration":
                        n.require(self._images is not None, site="item")
                        return
                    return super().item(item, completed)

                def turn(observer, turn, completed):
                    super().turn(turn, completed)
                    if completed:
                        self._collect(lambda: self._images.finish_turn(thread_id=self._thread, turn_id=observer.turn_id, status=turn["status"]))
            self._observer = ImageObserver

        def _now(self):
            value = self._clock()
            n.require(type(value) in {int, float} and math.isfinite(value), "CONFIG_REFUSED", "config")
            return value

        def _turn_deadline(self):
            return self._admitted_deadline

        def _remaining(self, deadline):
            n.require(not self._image_closed, "TRANSPORT_UNKNOWN", "cancelled")
            return super()._remaining(min(deadline, self._epoch_deadline))

        def _collect(self, call):
            try:
                return call()
            except c.ImageCollectorError as error:
                self._image_failure = error.code if error.code in FAILURES else "shape"
                raise n.Refused("BOUNDS_REFUSED" if self._image_failure in {"size", "budget"} else "PROTOCOL_REFUSED", "events") from None

        def _project(self, frame, items):
            if self._isolation_mode == "community-assessment":
                n.require(not any(type(item) is dict and item.get("type") == "imageGeneration" for item in items), "TOOL_REFUSED", "item")
            raw = n.encoded(frame)
            n.require(len(raw) <= IMAGE_FRAME_BYTES, "BOUNDS_REFUSED", "events")
            images = [item for item in items if type(item) is dict and item.get("type") == "imageGeneration"]
            if images:
                self._image_wire = min(IMAGE_LIFECYCLE_BYTES + 1, self._image_wire + len(raw))
                n.require(self._image_wire <= IMAGE_LIFECYCLE_BYTES, "BOUNDS_REFUSED", "events")
            ordinary = json.loads(raw)
            # Caller has already fed each original image to the collector.
            # Keep every envelope/metadata/unknown field under ordinary limits.
            def strip(value):
                if type(value) is not dict: return
                if value.get("type") == "imageGeneration": value["result"] = ""
                if value.get("type") != "userMessage" or type(value.get("content")) is not list: return
                # Only exact bytes already admitted by this host turn qualify.
                # Preserve text, IDs, image type/detail and all unknown fields.
                # A foreign URL or extra occurrence remains ordinary payload.
                available = [v["url"] for v in getattr(self, "_visual_inputs", [])]
                for entry in value["content"]:
                    if type(entry) is not dict or entry.get("type") != "image": continue
                    url = entry.get("url")
                    if type(url) is not str or url not in available: continue
                    available.remove(url)
                    self._input_echo_wire += len(url.encode("utf-8"))
                    n.require(self._input_echo_wire <= INPUT_ECHO_LIFECYCLE_BYTES, "BOUNDS_REFUSED", "events")
                    entry["url"] = "[host-admitted-image]"
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
            if getattr(self, "_visual_inputs", None): params = {**params, "input": [*params["input"], *self._visual_inputs]}
            reply = self._rpc.exchange(method, params, min(20.0, self._remaining(deadline)))
            self._remaining(deadline)
            n.require(type(reply) is tuple and len(reply) == 2, site="exchange")
            result, error = reply
            n.require(error is None, "TURN_REFUSED", "exchange")
            n.require(type(result) is dict and len(n.encoded(result)) <= IMAGE_FRAME_BYTES, site="exchange")
            turn = result.get("turn")
            n.require(type(turn) is dict and self._reviewed.opaque_id(turn.get("id")) and turn["id"] not in self._turn_ids
                      and type(turn.get("items")) is list and len(turn["items"]) <= n.EVENT_CAP, site="turn_ack")
            self._active_turn_id = turn["id"]
            self._images = c.NativeImageCollector({"requestRef": self._request_ref, "threadId": self._thread, "turnId": turn["id"]})
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
                    "exportReady": self._image_ready and not self._image_closed and not self._poisoned and not self._running}

        def _epoch_metadata(self):
            return {"schema": "neurobro-native-image-epoch-v1", "turnsAdmitted": self._attempts,
                    "turnLimit": EPOCH_TURNS, "epochSeconds": int(EPOCH_SECONDS), "turnSeconds": int(TURN_SECONDS),
                    "running": self._running, "releasePending": self._awaiting_release,
                    "closed": self._image_closed, "poisoned": self._poisoned,
                    "resourceSettlementObserved": False}

        def state(self):
            with self._state_lock:
                return {**super().state(), **self._epoch_metadata()}

        def _refusal(self, code):
            receipt = n.metadata()
            receipt.update(code=code, threadStarted=self._thread is not None, turnNumber=self._turns, sessionPoisoned=self._poisoned)
            return {"answer": None, "metadata": receipt, "imageMetadata": self._image_metadata(), "epochMetadata": self._epoch_metadata()}

        def run(self, text):
            # Prevent bypassing the epoch/request/release gate via the inherited
            # one-argument method. turn() invokes the reviewed base explicitly.
            raise EpochError("use-turn")

        def turn(self, request_ref, text, images=None):
            with self._state_lock:
                if self._image_closed: return self._refusal("SESSION_POISONED")
                if self._isolation_mode == "community-assessment" and images is not None: return self._refusal("INPUT_REFUSED")
                if self._running: return self._refusal("BUSY")
                if self._poisoned: return self._refusal("SESSION_POISONED")
                if self._awaiting_release: return self._refusal("BUSY")
                if not c.identifier(request_ref) or request_ref in self._seen_refs: return self._refusal("INPUT_REFUSED")
                try:
                    valid = type(text) is str and bool(text.strip()) and "\x00" not in text and 1 <= len(text.encode("utf-8")) <= n.INPUT_CAP
                except UnicodeError: valid = False
                if not valid: return self._refusal("INPUT_REFUSED")
                visual_inputs = []
                if images is not None:
                    try:
                        if type(images) is not list or not 1 <= len(images) <= 2: raise ValueError()
                        total = 0
                        for image in images:
                            if type(image) is not dict or set(image) != {"mimeType","base64"} or image["mimeType"] not in ("image/png","image/jpeg") or type(image["base64"]) is not str or len(image["base64"]) > 11184812: raise ValueError()
                            raw = base64.b64decode(image["base64"], validate=True)
                            total += len(raw)
                            if not raw or total > 8*1024*1024 or base64.b64encode(raw).decode("ascii") != image["base64"]: raise ValueError()
                            if not raw.startswith(b"\x89PNG\r\n\x1a\n" if image["mimeType"] == "image/png" else b"\xff\xd8\xff"): raise ValueError()
                            visual_inputs.append({"type":"image","url":"data:"+image["mimeType"]+";base64,"+image["base64"]})
                        raw = None
                    except Exception: return self._refusal("INPUT_REFUSED")
                now = self._now()
                if self._attempts >= EPOCH_TURNS or self._epoch_deadline - now < self._turn_seconds:
                    # Only this atomic precheck proves no admission. A later
                    # NativeConversation SESSION_LIMIT is not this evidence.
                    return {"kind": "notAdmitted", "requestRef": request_ref,
                            "reason": "turns" if self._attempts >= EPOCH_TURNS else "time",
                            "turnsAdmitted": self._attempts}
                self._visual_inputs = visual_inputs
                self._input_echo_wire = 0
                self._request_ref = request_ref; self._active_turn_id = None; self._seen_refs.add(request_ref)
                self._attempts += 1; self._running = True
                self._admitted_deadline = now + self._turn_seconds
                self._images = None; self._image_ready = False; self._image_failure = "none"
                self._image_wire = self._image_ack_ordinary = 0; self._generation += 1
            try:
                value = n.NativeConversation.run(self, text)
                with self._state_lock:
                    if self._image_closed:
                        self._poisoned = True
                        value["answer"] = None
                        # A prior terminal failure retains its original cause.
                        # Only a success racing revocation is changed to unknown.
                        if value["metadata"].get("outcome") == "observed":
                            value["metadata"].update(outcome="unknown", code="TRANSPORT_UNKNOWN", failureSite="cancelled")
                        value["metadata"]["sessionPoisoned"] = True
                    if value["metadata"]["outcome"] == "observed" and not self._poisoned:
                        status = self._images.metadata()["outcome"] if self._images is not None else None
                        if status == "completed": self._image_ready = True
                        elif status == "failed":
                            # The collector admits this only after matching start,
                            # terminal failure and successful native turn completion.
                            # Report that known outcome without exporting an image,
                            # replaying generation or trusting a possible success claim.
                            failure = self._images.metadata()["failureCode"]
                            value["answer"] = ("Не удалось получить готовую картинку: достигнут лимит генерации изображений."
                                if failure == "usageLimitExceeded" else
                                "Не удалось получить готовую картинку: генерация завершилась с ошибкой.")
                            value["metadata"]["answerBytes"] = len(value["answer"].encode("utf-8"))
                        elif status != "not-requested":
                            self._image_failure = "image-required"; self._poisoned = True
                            value["answer"] = None
                            value["metadata"].update(outcome="unknown", code="ANSWER_REFUSED", failureSite="answer_missing", sessionPoisoned=True)
                    if value["metadata"]["outcome"] == "observed" and not self._poisoned:
                        self._awaiting_release = True
                    else:
                        self._poisoned = True
                        value["metadata"]["sessionPoisoned"] = True
                        self._image_ready = False
                        if self._images is not None: self._images.close()
                    self._running = False
                    return {**value, "imageMetadata": self._image_metadata(), "epochMetadata": self._epoch_metadata()}
            finally:
                self._visual_inputs = []
                with self._state_lock:
                    self._running = False
                    if self._image_closed:
                        self._active_turn_id = None
                        if self._images is not None: self._images.close()

        def releaseTurn(self, request_ref, delivery):
            with self._state_lock:
                if self._image_closed: raise EpochError("closed")
                if self._running: raise EpochError("busy")
                if not self._awaiting_release or request_ref != self._request_ref or type(delivery) is not str or delivery not in DELIVERIES:
                    raise EpochError("release-refused")
                if self._images is not None: self._images.close()
                self._images = None; self._image_ready = False; self._awaiting_release = False
                self._request_ref = None; self._active_turn_id = None; self._generation += 1
                if delivery == "unknown": self._poisoned = True
                return self._epoch_metadata()

        def _completion_guard(self):
            if self._image_closed or self._poisoned or self._running or not self._awaiting_release or self._active_turn_id is None or self._now() >= self._epoch_deadline:
                raise EpochError("completion-refused")

        def completed_turn_scope(self):
            """Private correlation only; never include these IDs in safe metadata."""
            with self._state_lock:
                self._completion_guard()
                return {"requestRef": self._request_ref, "threadId": self._thread,
                        "turnId": self._active_turn_id, "turnNumber": self._turns}

        def _export_guard(self, generation=None):
            self._completion_guard()
            if not self._image_ready or (generation is not None and generation != self._generation):
                raise EpochError("export-refused")

        def image_artifact(self):
            with self._state_lock:
                self._export_guard()
                return self._images.artifact_record()

        def image_frames(self):
            with self._state_lock:
                self._export_guard()
                generation = self._generation
                frames = self._images.artifact_frames()
            # Capture the lease now, not on first next(): an unstarted iterator
            # from a released turn must never bind itself to a later image.
            def iterator():
                while True:
                    with self._state_lock:
                        self._export_guard(generation)
                        try: frame = next(frames)
                        except StopIteration: return
                    yield frame
            return iterator()

        def close(self):
            with self._state_lock:
                self._image_closed = True; self._image_ready = False; self._active_turn_id = None; self._generation += 1
                if self._running: self._poisoned = True
                else:
                    if self._images is not None: self._images.close()
                    self._images = None
                self._awaiting_release = False
                return self._epoch_metadata()

    return NativeImageEpoch()
