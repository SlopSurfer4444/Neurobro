"""Pure idle validation against installed0.153.4 v2 notification schemas.
No I/O/actions or payload retention. Owner supplies completed scope/confirmed
native IDs; None/None means startup. Warnings, apps, skills and MCP are metadata
only; no refresh/auth/use. Extra fields, non-idle status, active remote control,
account changes and unknown lifecycles refuse. Nonnegative token counts are a
local constraint; warning positions use schema minimum0. Owner enforces single
reader, aggregate epoch budgets and poison retirement. Observed clearance cannot
exclude future events. Caps match native512events/256KiB/4refusals/12seed IDs.
"""
import json
import re

FRAME_CAP = BYTE_CAP = 262144
FRAME_COUNT = 512
RESPONDED_CAP, LATE_REFUSAL_CAP = 12, 4
HISTORY_TOOL = "neurobro_read_history"
METHODS = frozenset({"skills/changed", "remoteControl/status/changed",
                    "configWarning", "deprecationNotice",
                    "app/list/updated", "mcpServer/startupStatus/updated",
                    "thread/status/changed", "thread/tokenUsage/updated",
                    "serverRequest/resolved", "item/tool/call"})
TOKEN_KEYS = frozenset({"cachedInputTokens", "inputTokens", "outputTokens",
                        "reasoningOutputTokens", "totalTokens"})


class IdleError(Exception):
    def __init__(self, code, site):
        super().__init__(code)
        self.code, self.site = code, site


def identifier(value):
    try:
        return (type(value) is str and 0 < len(value.encode("utf-8")) <= 128
                and "\x00" not in value and not any(c.isspace() for c in value))
    except UnicodeError: return False


def request_key(value):
    if type(value) is int and -(2**63) <= value < 2**63: return ("int", value)
    # NativeConversation request IDs are typed opaque JSON values, not thread
    # identifiers: preserve spaces/control characters when within its wire cap.
    try:
        if (type(value) is str and 0 < len(value.encode("utf-8")) <= 128
                and len(json.dumps(value, ensure_ascii=False).encode("utf-8")) <= 258):
            return ("str", value)
    except UnicodeError: pass
    return None


def count(value):
    return type(value) is int and 0 <= value < 2**63


def nullable_fields(value, names, expected):
    return all(value.get(key) is None or type(value[key]) is expected for key in names)


def app_info(value):
    # Closed known-field projections are locally narrower than the installed
    # extensible schema. Nested strings remain untrusted, bounded frame data.
    strings = {"description", "distributionChannel", "installUrl", "logoUrl", "logoUrlDark"}
    mappings = {"iconAssets", "iconDarkAssets", "labels"}
    allowed = strings | mappings | {"id", "name", "isAccessible", "isEnabled", "pluginDisplayNames", "branding", "appMetadata"}
    if (type(value) is not dict or not set(value) <= allowed
            or type(value.get("id")) is not str or type(value.get("name")) is not str
            or not nullable_fields(value, strings, str)): return False
    if any(key in value and type(value[key]) is not bool for key in ("isAccessible", "isEnabled")): return False
    for key in mappings:
        mapping = value.get(key)
        if mapping is not None and (type(mapping) is not dict or any(type(k) is not str or type(v) is not str for k, v in mapping.items())): return False
    if "pluginDisplayNames" in value and (type(value["pluginDisplayNames"]) is not list or any(type(x) is not str for x in value["pluginDisplayNames"])): return False
    branding = value.get("branding")
    brand_strings = {"category", "developer", "privacyPolicy", "termsOfService", "website"}
    if branding is not None and (type(branding) is not dict or not set(branding) <= brand_strings | {"isDiscoverableApp"}
            or type(branding.get("isDiscoverableApp")) is not bool or not nullable_fields(branding, brand_strings, str)): return False
    meta = value.get("appMetadata")
    if meta is None: return True
    meta_strings = {"developer", "seoDescription", "version", "versionId", "versionNotes"}
    meta_bools = {"firstPartyRequiresInstall", "showInComposerWhenUnlinked"}
    if (type(meta) is not dict or not set(meta) <= meta_strings | meta_bools | {"categories", "subCategories", "review", "screenshots"}
            or not nullable_fields(meta, meta_strings, str) or not nullable_fields(meta, meta_bools, bool)): return False
    for key in ("categories", "subCategories"):
        items = meta.get(key)
        if items is not None and (type(items) is not list or any(type(x) is not str for x in items)): return False
    review = meta.get("review")
    if review is not None and (type(review) is not dict or set(review) != {"status"} or type(review["status"]) is not str): return False
    shots = meta.get("screenshots")
    return shots is None or type(shots) is list and all(type(x) is dict and set(x) <= {"userPrompt", "fileId", "url"}
            and type(x.get("userPrompt")) is str and nullable_fields(x, ("fileId", "url"), str) for x in shots)


class EpochIdleValidator:
    def __init__(self, thread_id, turn_id, responded_request_ids=(), *, tool_names=None):
        names = (HISTORY_TOOL,) if tool_names is None else tool_names
        if (type(names) is not tuple or not 1 <= len(names) <= 32 or names[0] != HISTORY_TOOL
                or any(type(n) is not str or re.fullmatch(r"neurobro_[a-z][a-z0-9_]{0,54}", n) is None for n in names)
                or len(set(names)) != len(names)):
            raise IdleError("CONFIG_REFUSED", "scope")
        self._tools = frozenset(names)
        starting = thread_id is None and turn_id is None
        if not starting and not (identifier(thread_id) and identifier(turn_id)):
            raise IdleError("CONFIG_REFUSED", "scope")
        if type(responded_request_ids) not in (tuple, list) or len(responded_request_ids) > RESPONDED_CAP:
            raise IdleError("CONFIG_REFUSED", "response_ids")
        keys = [request_key(value) for value in responded_request_ids]
        if any(key is None for key in keys) or len(set(keys)) != len(keys) or starting and keys:
            raise IdleError("CONFIG_REFUSED", "response_ids")
        self._thread, self._turn = thread_id, turn_id
        self._confirmed = set(keys)
        self._seen, self._calls, self._pending = set(keys), set(), set()
        self._frames = self._bytes = self._refusals = self._resolved = 0
        self._poisoned = False

    def _fail(self, code, site):
        self._poisoned = True
        raise IdleError(code, site)

    def _need(self, valid, site, code="PROTOCOL_REFUSED"):
        if not valid: self._fail(code, site)

    def _healthy(self):
        if self._poisoned: raise IdleError("SESSION_POISONED", "poisoned")

    def _breakdown(self, value):
        return (type(value) is dict and TOKEN_KEYS <= set(value)
                and set(value) <= TOKEN_KEYS | {"cacheWriteInputTokens"}
                and all(count(n) for n in value.values()))

    def _warning(self, method, value):
        allowed = {"summary", "details"}
        if method == "configWarning": allowed |= {"path", "range"}
        valid = (set(value) <= allowed and type(value.get("summary")) is str
                 and (value.get("details") is None or type(value["details"]) is str))
        if valid and method == "configWarning":
            valid = value.get("path") is None or type(value["path"]) is str
            span = value.get("range")
            if span is not None:
                valid = valid and type(span) is dict and set(span) == {"start", "end"}
                if valid:
                    valid = all(type(pos) is dict and set(pos) == {"line", "column"}
                                and all(type(n) is int and n >= 0 for n in pos.values())
                                for pos in span.values())
        self._need(valid, "warning")

    def observe(self, frame):
        self._healthy()
        try:
            raw = json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except Exception: self._fail("PROTOCOL_REFUSED", "frame")
        self._frames += 1
        self._bytes = min(BYTE_CAP + 1, self._bytes + len(raw))
        self._need(len(raw) <= FRAME_CAP and self._bytes <= BYTE_CAP and self._frames <= FRAME_COUNT, "budget", "BOUNDS_REFUSED")
        self._need(type(frame) is dict and set(frame) in ({"method", "params"}, {"id", "method", "params"}), "envelope")
        method, p = frame["method"], frame["params"]
        self._need(type(method) is str and method in METHODS and type(p) is dict, "method")
        if "id" in frame: return self._request(frame["id"], method, p)
        self._need(method != "item/tool/call", "envelope")
        if method in {"configWarning", "deprecationNotice"}:
            self._warning(method, p)
        elif method == "app/list/updated":
            self._need(set(p) == {"data"} and type(p["data"]) is list and all(app_info(row) for row in p["data"]), "apps")
        elif method == "mcpServer/startupStatus/updated":
            self._need(set(p) <= {"name", "status", "error", "failureReason", "threadId"}
                       and type(p.get("name")) is str and type(p.get("status")) is str
                       and p["status"] in {"starting", "ready", "failed", "cancelled"}
                       and p.get("failureReason") in (None, "reauthenticationRequired")
                       and nullable_fields(p, ("error",), str)
                       and (p.get("threadId") is None or type(p["threadId"]) is str and p["threadId"] == self._thread), "mcp_status")
        elif method == "skills/changed":
            self._need(not p, "skills")
        elif method == "remoteControl/status/changed":
            self._need(set(p) in ({"installationId", "serverName", "status"}, {"installationId", "serverName", "status", "environmentId"})
                       and type(p.get("installationId")) is str and type(p.get("serverName")) is str, "remote_control")
            self._need(p.get("status") == "disabled" and p.get("environmentId") is None, "remote_control", "CUSTODY_REFUSED")
        else:
            self._need(self._thread is not None and p.get("threadId") == self._thread, "thread")
            if method == "thread/status/changed":
                self._need(set(p) == {"threadId", "status"} and type(p["status"]) is dict
                           and p["status"] == {"type": "idle"}, "status")
            elif method == "thread/tokenUsage/updated":
                self._need(set(p) == {"threadId", "turnId", "tokenUsage"} and p.get("turnId") == self._turn, "turn")
                usage = p["tokenUsage"]
                self._need(type(usage) is dict and set(usage) in ({"last", "total"}, {"last", "total", "modelContextWindow"})
                           and self._breakdown(usage.get("last")) and self._breakdown(usage.get("total"))
                           and (usage.get("modelContextWindow") is None or count(usage["modelContextWindow"])), "token_usage")
            elif method == "serverRequest/resolved":
                self._need(set(p) == {"threadId", "requestId"}, "resolved")
                key = request_key(p["requestId"])
                self._need(key is not None and key in self._confirmed, "resolved")
                self._resolved += 1
        return {"kind": "notification"}

    def _request(self, request_id, method, p):
        self._need(method == "item/tool/call", "request", "TOOL_REFUSED")
        key = request_key(request_id)
        self._need(key is not None and key not in self._seen, "request_id", "TOOL_REFUSED")
        self._need(set(p) in ({"arguments", "callId", "threadId", "turnId", "tool"},
                             {"arguments", "callId", "threadId", "turnId", "tool", "namespace"}), "request", "TOOL_REFUSED")
        self._need(self._thread is not None and p.get("threadId") == self._thread and p.get("turnId") == self._turn
                   and type(p.get("tool")) is str and p["tool"] in self._tools and p.get("namespace") is None, "correlation", "TOOL_REFUSED")
        self._need(identifier(p.get("callId")) and p["callId"] not in self._calls, "call_id", "TOOL_REFUSED")
        self._need(self._refusals < LATE_REFUSAL_CAP, "refusal_budget", "BOUNDS_REFUSED")
        self._seen.add(key); self._calls.add(p["callId"]); self._pending.add(key)
        self._refusals += 1
        # Arguments are never executed. A late request receives the same native
        # response shape as a refused history call, with an explicit idle reason.
        result = {"success": False, "contentItems": [{"type": "inputText", "text":
                  '{"schema":"neurobro-history-tool-error-v1","code":"turn-not-active"}'}]}
        return {"kind": "refuse-tool", "requestId": request_id, "result": result}

    def confirm_response(self, request_id):
        """Owner calls only after exact rpc.respond completed successfully.

        A write exception/timeout must retire the epoch, never confirm or retry.
        This records the caller's successful-write assertion, not OS settlement.
        """
        self._healthy()
        key = request_key(request_id)
        self._need(key is not None and key in self._pending, "response_confirmation", "TOOL_REFUSED")
        self._pending.remove(key); self._confirmed.add(key)

    def state(self):
        return {"poisoned": self._poisoned, "frames": self._frames, "bytes": self._bytes,
                "lateRefusals": self._refusals, "pendingResponses": len(self._pending),
                "confirmedResponses": len(self._confirmed), "resolvedNotifications": self._resolved}

    def idle_clear(self, rpc_state):
        """Observed clearance only. No proof against future late input."""
        self._healthy()
        self._need(type(rpc_state) is dict and set(rpc_state) == {"partialBytes", "queuedFrames", "pendingRequests", "stdoutEofObserved"}
                   and all(count(rpc_state[k]) for k in ("partialBytes", "queuedFrames", "pendingRequests"))
                   and type(rpc_state["stdoutEofObserved"]) is bool, "rpc_state")
        return (not self._pending and not rpc_state["stdoutEofObserved"]
                and all(rpc_state[k] == 0 for k in ("partialBytes", "queuedFrames", "pendingRequests")))


class ScopedEpochIdleRegistry:
    """Two private bindings, one reader; inactive requests NEVER execute.

    Active frames are returned to their engine unchanged. Only exact legacy
    idle notifications may be consumed for a known inactive thread. Aggregate
    late/idle budgets do not reset when switching slots or replacing validators.
    """
    PURPOSES = ("conversation", "history-analysis")

    def __init__(self, *, idle_sentinel, clock=None):
        import time
        self.clock = clock or time.monotonic
        self._idle = idle_sentinel
        self._threads, self._validators = {}, {}
        self._global = EpochIdleValidator(None, None)
        self._frames = self._bytes = 0
        self._poisoned = False

    def _need(self, valid, site="scope"):
        if self._poisoned or not valid:
            self._poisoned = True
            raise IdleError("PROTOCOL_REFUSED", site)

    def start(self, purpose, thread_id):
        self._need(type(purpose) is str and purpose in self.PURPOSES and purpose not in self._threads and identifier(thread_id) and thread_id not in self._threads.values())
        self._threads[purpose] = thread_id

    def complete(self, purpose, thread_id, turn_id, response_ids):
        self._need(type(purpose) is str and self._threads.get(purpose) == thread_id and identifier(turn_id))
        # No request is passed to these validators, so their legacy default
        # history tool registration grants no capability or callback route.
        self._validators[purpose] = EpochIdleValidator(thread_id, turn_id, response_ids)

    def route(self, frame, active_purpose=None):
        self._need(active_purpose is None or active_purpose in self.PURPOSES)
        self._need(type(frame) is dict and type(frame.get("params")) is dict, "frame")
        params = frame["params"]
        thread = params.get("threadId")
        if thread is None and type(params.get("thread")) is dict: thread = params["thread"].get("id")
        if thread is not None:
            self._need(type(thread) is str and thread in self._threads.values(), "thread")
            purpose = next(p for p, t in self._threads.items() if t == thread)
            if purpose == active_purpose: return False
            self._need(purpose in self._validators, "turn")
            validator = self._validators[purpose]
        else:
            if active_purpose is not None: return False
            validator = self._global
        # Even a correctly correlated old tool request is not new authority.
        self._need("id" not in frame, "request")
        try: size = len(json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode())
        except Exception: self._need(False, "frame")
        self._frames += 1; self._bytes += size
        self._need(self._frames <= FRAME_COUNT and self._bytes <= BYTE_CAP, "budget")
        try: result = validator.observe(frame)
        except Exception:
            self._poisoned = True
            raise
        self._need(result == {"kind": "notification"}, "request")
        return True

    def poll(self, rpc, seconds):
        self._need(type(seconds) in (int, float) and 0 < seconds <= 1, "budget")
        deadline = self.clock() + seconds
        while self.clock() < deadline:
            # The transport's IDLE singleton is injected through its module's
            # public poll result: any non-dict value must be the caller's sentinel.
            frame = rpc.poll_frame(max(0.0, min(1.0, deadline - self.clock())))
            if type(frame) is not dict:
                self._need(frame is self._idle, "frame")
                state = rpc.idle_state()
                if self._global.idle_clear(state): return "clear"
            else: self.route(frame)
        return "blocked"

    def state(self):
        return {"poisoned": self._poisoned, "boundThreads": len(self._threads), "frames": self._frames, "bytes": self._bytes}
