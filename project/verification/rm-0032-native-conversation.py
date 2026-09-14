"""Pure native conversation state machine. No process, files, network or logging.

RPC is already custody-approved and owns framing, duplicate JSON-key rejection,
bounded queues and hard I/O deadlines. exchange queues interleaved notifications
and server requests; next_frame returns them in original order. No other reader
may consume that RPC. This module never asserts OS/process settlement.
"""
import hashlib
import json
import re
import threading
import time
import types

CANARY_SHA256 = "43E9422897B97CE4DC9AACD40494E94D89FD770AD84B9E6361666A6F70D3D967"
NAME = "neurobro_read_history"
INPUT_CAP, ANSWER_CAP = 24576, 4096
EVENT_CAP, EVENT_BYTES_CAP = 512, 262144
TOOL_TEXT_CAP, TOOL_WIRE_CAP, TOOL_CALL_CAP = 65536, 262144, 8
TOOL_REPLY_RESERVATION, TOOL_TURN_WIRE_CAP = 131584, 1048576
TOOL_REFUSAL_CAP, HISTORY_LIFECYCLE_CAP = 4, 2097152
SESSION_TURN_CAP, WORK_SECONDS = 256, 125.0
SCHEMA = "decadans.rm0032.native-conversation.v1"

OBSERVER_SITES = frozenset(('account_shape', 'base_protocol', 'delta_shape', 'delta_utf8', 'error_shape', 'event_params', 'item_conflict', 'item_shape', 'item_text', 'item_utf8', 'model_metadata_shape', 'none', 'notification_expected', 'notification_item', 'notification_shape', 'rpc_after_model', 'rpc_budget', 'rpc_frame', 'rpc_id', 'rpc_json', 'rpc_method', 'rpc_result', 'settings_shape', 'status_shape', 'thread_event', 'thread_id', 'thread_response', 'turn_id', 'turn_response', 'turn_shape', 'warning_shape'))
OBSERVER_METHODS = frozenset(('account/login/completed', 'account/rateLimits/updated', 'account/read', 'account/updated', 'app/list/updated', 'autoApprovalReview/strictReviewRequired', 'command/exec', 'command/exec/outputDelta', 'configWarning', 'deprecationNotice', 'error', 'externalAgentConfig/import/completed', 'externalAgentConfig/import/progress', 'fs/changed', 'fuzzyFileSearch/sessionCompleted', 'fuzzyFileSearch/sessionUpdated', 'guardianWarning', 'hook/completed', 'hook/started', 'initialize', 'item/agentMessage/delta', 'item/autoApprovalReview/completed', 'item/autoApprovalReview/started', 'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction', 'item/completed', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated', 'item/mcpToolCall/progress', 'item/plan/delta', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/started', 'mcpServer/event/stream/notification', 'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated', 'model/list', 'model/rerouted', 'model/safetyBuffering/updated', 'model/verification', 'modelProvider/authRecoveryCompleted', 'modelProvider/authRecoveryStarted', 'none', 'other', 'permissionProfile/list', 'process/exited', 'process/outputDelta', 'project/changed', 'remoteControl/status/changed', 'serverRequest/resolved', 'skills/changed', 'thread/archived', 'thread/closed', 'thread/compacted', 'thread/deleted', 'thread/environment/connected', 'thread/environment/disconnected', 'thread/goal/cleared', 'thread/goal/updated', 'thread/name/updated', 'thread/project/updated', 'thread/queue/changed', 'thread/realtime/closed', 'thread/realtime/error', 'thread/realtime/item/completed', 'thread/realtime/item/started', 'thread/realtime/item/transcript/delta', 'thread/realtime/itemAdded', 'thread/realtime/outputAudio/delta', 'thread/realtime/sdp', 'thread/realtime/started', 'thread/realtime/transcript/delta', 'thread/realtime/transcript/done', 'thread/reverted', 'thread/settings/updated', 'thread/start', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'thread/unarchived', 'turn/completed', 'turn/diff/updated', 'turn/moderationMetadata', 'turn/plan/updated', 'turn/start', 'turn/started', 'warning', 'windows/worldWritableWarning', 'windowsSandbox/setupCompleted'))
OBSERVER_SHAPES = ('paramsObject', 'threadIdPresent', 'threadIdMatched', 'turnIdPresent', 'turnIdMatched', 'nestedThreadObject', 'nestedTurnObject', 'nestedItemObject', 'turnItemsList', 'threadEphemeralPresent', 'threadEphemeralTrue')


REMOTE_STATUSES = frozenset({"not_seen", "invalid", "disabled", "connecting", "connected", "errored"})

def observer_metadata():
    return {"site": "none", "method": "none", "shape": dict.fromkeys(OBSERVER_SHAPES, False), "remoteControlStatus": "not_seen"}


class Refused(Exception):
    def __init__(self, code, site):
        self.code, self.site = code, site


def require(condition, code="PROTOCOL_REFUSED", site="frame"):
    if not condition: raise Refused(code, site)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def proof(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()).digest()


def request_id(value):
    return (type(value) is str and 0 < len(value.encode("utf-8")) <= 128 and len(encoded(value)) <= 258
            or type(value) is int and -(2**63) <= value < 2**63)


def history_arguments(value):
    require(type(value) is dict and set(value) == {"fromDate", "toDate", "cursor"}, "TOOL_REFUSED", "arguments")
    require(all(type(value[k]) is int and 1 <= value[k] <= 2147483646 for k in ("fromDate", "toDate")), "TOOL_REFUSED", "arguments")
    require(value["fromDate"] <= value["toDate"], "TOOL_REFUSED", "arguments")
    cursor = value["cursor"]
    require(cursor is None or type(cursor) is str and re.fullmatch(r"[0-9a-f-]{36}", cursor) is not None, "TOOL_REFUSED", "arguments")


def validate_spec(spec):
    require(type(spec) is dict and set(spec) in ({"type", "name", "description", "inputSchema"}, {"type", "name", "description", "inputSchema", "deferLoading"}), "CONFIG_REFUSED", "spec")
    require(spec.get("type") == "function" and spec.get("name") == NAME, "CONFIG_REFUSED", "spec")
    require(type(spec.get("description")) is str and 1 <= len(spec["description"].encode()) <= 2048, "CONFIG_REFUSED", "spec")
    require("deferLoading" not in spec or spec["deferLoading"] is False, "CONFIG_REFUSED", "spec")
    schema = spec.get("inputSchema")
    require(type(schema) is dict and set(schema) == {"type", "additionalProperties", "properties", "required"}, "CONFIG_REFUSED", "spec")
    require(schema["type"] == "object" and schema["additionalProperties"] is False and type(schema["required"]) is list and sorted(schema["required"]) == ["cursor", "fromDate", "toDate"], "CONFIG_REFUSED", "spec")
    props = schema["properties"]
    require(type(props) is dict and set(props) == {"fromDate", "toDate", "cursor"}, "CONFIG_REFUSED", "spec")
    for key in ("fromDate", "toDate"):
        require(props[key] == {"type": "integer", "minimum": 1, "maximum": 2147483646}, "CONFIG_REFUSED", "spec")
    cursor = props["cursor"]
    require(type(cursor) is dict and set(cursor) <= {"type", "description"} and cursor.get("type") == ["string", "null"], "CONFIG_REFUSED", "spec")
    if "description" in cursor: require(type(cursor["description"]) is str and len(cursor["description"].encode()) <= 2048, "CONFIG_REFUSED", "spec")
    return json.loads(encoded(spec))


def extra_registry(entries, history_spec):
    # Trusted controller supplies validators, never a model/tool payload. This
    # validates the bounded declaration, not arbitrary JSON Schema semantics.
    require(type(entries) in (tuple, list) and len(entries) <= 31, "CONFIG_REFUSED", "spec")
    specs, validators = [history_spec], {NAME: history_arguments}
    try:
        for entry in entries:
            require(type(entry) is dict and set(entry) == {"spec", "validate"} and callable(entry["validate"]), "CONFIG_REFUSED", "spec")
            raw = encoded(entry["spec"])
            require(len(raw) <= 8192, "CONFIG_REFUSED", "spec")
            spec = json.loads(raw)
            require(type(spec) is dict and set(spec) in ({"type", "name", "description", "inputSchema"}, {"type", "name", "description", "inputSchema", "deferLoading"}), "CONFIG_REFUSED", "spec")
            name = spec.get("name")
            require(type(name) is str and re.fullmatch(r"neurobro_[a-z][a-z0-9_]{0,54}", name) and name not in validators, "CONFIG_REFUSED", "spec")
            require(spec["type"] == "function" and type(spec["description"]) is str and 0 < len(spec["description"].encode()) <= 2048 and spec.get("deferLoading", False) is False, "CONFIG_REFUSED", "spec")
            schema = spec["inputSchema"]
            require(type(schema) is dict and set(schema) == {"type", "additionalProperties", "properties", "required"}
                    and schema["type"] == "object" and schema["additionalProperties"] is False, "CONFIG_REFUSED", "spec")
            props, required = schema["properties"], schema["required"]
            require(type(props) is dict and all(type(v) is dict for v in props.values()) and type(required) is list
                    and all(type(k) is str and k in props for k in required) and len(set(required)) == len(required), "CONFIG_REFUSED", "spec")
            specs.append(spec); validators[name] = entry["validate"]
        require(len(encoded(specs)) <= 32768, "CONFIG_REFUSED", "spec")
    except Refused: raise
    except Exception: raise Refused("CONFIG_REFUSED", "spec") from None
    return specs, validators


def metadata():
    return {"schema": SCHEMA, "outcome": "refused", "code": "NOT_RUN", "stage": "validate", "failureSite": "none",
            "threadStarted": False, "turnAttempted": False, "turnCompleted": False, "sessionPoisoned": False,
            "turnNumber": 0, "inputBytes": 0, "answerBytes": 0, "eventCount": 0, "eventBytes": 0,
            "toolCalls": 0, "toolRefusals": 0, "toolResultBytes": 0, "toolBudgetExhausted": False,
            "historyLifecycleBytes": 0, "observer": observer_metadata()}


def _nullable_fields(value, names, expected):
    return all(value.get(key) is None or type(value[key]) is expected for key in names)


def _app_metadata(value):
    if value is None: return True
    if type(value) is not dict: return False
    if not _nullable_fields(value, ("developer", "seoDescription", "version", "versionId", "versionNotes"), str): return False
    if not _nullable_fields(value, ("firstPartyRequiresInstall", "showInComposerWhenUnlinked"), bool): return False
    for key in ("categories", "subCategories"):
        items = value.get(key)
        if items is not None and (type(items) is not list or any(type(x) is not str for x in items)): return False
    review = value.get("review")
    if review is not None and (type(review) is not dict or type(review.get("status")) is not str): return False
    shots = value.get("screenshots")
    return shots is None or type(shots) is list and all(type(x) is dict and type(x.get("userPrompt")) is str and _nullable_fields(x, ("fileId", "url"), str) for x in shots)


def _app_info(value):
    if type(value) is not dict or type(value.get("id")) is not str or type(value.get("name")) is not str: return False
    if not _nullable_fields(value, ("description", "distributionChannel", "installUrl", "logoUrl", "logoUrlDark"), str): return False
    if any(key in value and type(value[key]) is not bool for key in ("isAccessible", "isEnabled")): return False
    for key in ("iconAssets", "iconDarkAssets", "labels"):
        mapping = value.get(key)
        if mapping is not None and (type(mapping) is not dict or any(type(x) is not str for x in mapping.values())): return False
    if "pluginDisplayNames" in value and (type(value["pluginDisplayNames"]) is not list or any(type(x) is not str for x in value["pluginDisplayNames"])): return False
    branding = value.get("branding")
    if branding is not None and (type(branding) is not dict or type(branding.get("isDiscoverableApp")) is not bool or not _nullable_fields(branding, ("category", "developer", "privacyPolicy", "termsOfService", "website"), str)): return False
    return _app_metadata(value.get("appMetadata"))


def web_counts():
    return dict.fromkeys(("admitted", "completed", "search", "openPage", "findInPage", "other"), 0)


def web_proof(item):
    # Installed v2 WebSearchThreadItem/Action. Results are intentionally opaque
    # JSON; validate their container and byte budget, retain only a digest. The
    # observer never fetches a URL or grants any host tool authority.
    require(set(item) <= {"id", "type", "query", "action", "results"}, site="web_item")
    def field(value):
        require(type(value) is str and "\x00" not in value, site="web_item")
        try: raw = value.encode("utf-8")
        except UnicodeError: raise Refused("PROTOCOL_REFUSED", "web_item") from None
        require(len(raw) <= 4096, "BOUNDS_REFUSED", "web_item")
        return proof(value)
    query = field(item.get("query"))
    values = {"query": None if item["query"] == "" else query, "action": None, "results": None}
    action = item.get("action")
    if action is not None:
        require(type(action) is dict and type(action.get("type")) is str, site="web_item")
        kind = action["type"]
        fields = {"search": ("query", "queries"), "openPage": ("url",), "findInPage": ("url", "pattern"), "other": ()}
        require(kind in fields and set(action) <= {"type", *fields[kind]}, site="web_item")
        values["action"] = kind
        for name in fields[kind]:
            value = action.get(name)
            if value is None: continue
            if name == "queries":
                require(type(value) is list and len(value) <= 32, "BOUNDS_REFUSED", "web_item")
                for entry in value: field(entry)
                values[name] = proof(value)
            else: values["action_" + name] = field(value)
    results = item.get("results")
    require(results is None or type(results) is list, site="web_item")
    try: raw = encoded(item)
    except (ValueError, TypeError, UnicodeError): raise Refused("PROTOCOL_REFUSED", "web_item") from None
    require(len(raw) <= 65536, "BOUNDS_REFUSED", "web_item")
    if results is not None: values["results"] = proof(results)
    return values


def observer_class(reviewed):
    class Observer(reviewed.Observer):
        def __init__(self, engine, counts, turn_id):
            super().__init__(counts, engine._thread, turn_id, reviewed.diagnostic_result())
            self.engine, self.answer, self.final_id = engine, None, None
            self.remote_control_status = "not_seen"
            self.agent_proofs, self.tool_proofs, self.tool_completed = {}, {}, {}
            self.web_items, self.item_kinds = {}, {}

        def item(self, item, completed):
            require(type(item) is dict and reviewed.opaque_id(item.get("id")), site="item")
            kind = item.get("type")
            if self.engine._enable_web:
                prior_kind = self.item_kinds.get(item["id"])
                require(prior_kind is None or prior_kind == kind, site="web_changed")
                self.item_kinds[item["id"]] = kind
                require(len(self.item_kinds) <= EVENT_CAP, "BOUNDS_REFUSED", "web_item")
            if kind == "webSearch" and self.engine._enable_web:
                current, previous = web_proof(item), self.web_items.get(item["id"])
                if previous is not None:
                    old, was_completed = previous
                    # Only incomplete -> completed may fill missing fields.
                    # Nonempty known values and every terminal repeat are exact.
                    require(not was_completed or completed, site="web_changed")
                    if completed and not was_completed:
                        require(all(value is None or current.get(key) == value for key, value in old.items()), site="web_changed")
                    else: require(current == old, site="web_changed")
                else:
                    self.engine._web_counts["admitted"] += 1
                self.web_items[item["id"]] = (current, completed)
                if completed and (previous is None or not previous[1]):
                    self.engine._web_counts["completed"] += 1
                    if current["action"] is not None: self.engine._web_counts[current["action"]] += 1
                return
            if kind == "dynamicToolCall":
                require(self.engine._registered(item.get("tool")) and item.get("namespace") is None, "TOOL_REFUSED", "tool_item")
                require("arguments" in item, site="tool_item")
                require(item.get("status") in {"inProgress", "completed", "failed"}, site="tool_item")
                require(not completed or item["status"] in {"completed", "failed"}, site="tool_item")
                if item.get("success") is not None: require(type(item["success"]) is bool, site="tool_item")
                if item.get("durationMs") is not None: require(type(item["durationMs"]) is int and item["durationMs"] >= 0, site="tool_item")
                content = item.get("contentItems")
                if content is not None: self.engine._tool_content(content)
                fingerprint = proof({"arguments": item["arguments"], "tool": item["tool"], "namespace": item.get("namespace")})
                prior = self.tool_proofs.get(item["id"])
                require(prior is None or prior == fingerprint, site="tool_item")
                self.tool_proofs[item["id"]] = fingerprint
                if completed:
                    terminal = (fingerprint, item["status"], item.get("success"), None if content is None else proof(content))
                    old = self.tool_completed.get(item["id"])
                    if old is not None:
                        require(old[:2] == terminal[:2] and all(a is None or b is None or a == b for a, b in zip(old[2:], terminal[2:])), "TOOL_REFUSED", "tool_item_changed")
                        terminal = tuple(a if a is not None else b for a, b in zip(old, terminal))
                    self.tool_completed[item["id"]] = terminal
                require(len(self.tool_proofs) <= TOOL_CALL_CAP + TOOL_REFUSAL_CAP, "BOUNDS_REFUSED", "tool_item")
                return
            if kind != "agentMessage": return super().item(item, completed)
            if not completed: return
            phase, text = item.get("phase"), item.get("text")
            require(phase in {None, "commentary", "final_answer"} and item.get("delivery") is None and item.get("questions") in (None, []), "ANSWER_REFUSED", "answer")
            require(type(text) is str, site="answer")
            size = len(text.encode("utf-8"))
            require(size <= ANSWER_CAP, "BOUNDS_REFUSED", "answer")
            fingerprint = (phase, hashlib.sha256(text.encode()).digest())
            prior = self.agent_proofs.get(item["id"])
            require(prior is None or prior == fingerprint, "ANSWER_REFUSED", "answer_changed")
            self.agent_proofs[item["id"]] = fingerprint
            require(len(self.agent_proofs) <= EVENT_CAP, "BOUNDS_REFUSED", "answer")
            if phase == "commentary": return
            require(text.strip() and (self.final_id is None or self.final_id == item["id"]), "ANSWER_REFUSED", "answer")
            self.final_id, self.answer = item["id"], text

        def turn(self, turn, completed):
            require(type(turn) is dict and turn.get("id") == self.turn_id and type(turn.get("items")) is list, site="turn")
            require(len(turn["items"]) <= EVENT_CAP, "BOUNDS_REFUSED", "turn")
            require(turn.get("status") in {"inProgress", "completed", "failed", "interrupted"}, site="turn")
            require(turn.get("itemsView", "full") in {"full", "summary", "notLoaded"}, site="turn")
            for item in turn["items"]: self.item(item, completed)
            if completed:
                require(all(done for _, done in self.web_items.values()), "TOOL_REFUSED", "web_unfinished")
                require(set(self.engine._current_calls) == set(self.tool_completed), "TOOL_REFUSED", "tool_item_missing")
                for call_id, fingerprint in self.tool_proofs.items():
                    require(call_id in self.engine._current_calls and self.engine._current_calls[call_id][0] == fingerprint, "TOOL_REFUSED", "tool_item_correlation")
                for call_id, (fingerprint, status, success, content) in self.tool_completed.items():
                    actual = self.engine._current_calls[call_id]
                    require((success is None or success == actual[1]) and (content is None or content == actual[2]), "TOOL_REFUSED", "tool_item_result")
                require(turn["status"] == "completed" and turn.get("error") is None, "TURN_REFUSED", "turn")
                require(self.answer is not None, "ANSWER_REFUSED", "answer_missing")
                self.canary["turnCompleted"] = True

        def event(self, frame):
            method, params = frame.get("method"), frame.get("params")
            reviewed.diagnostic_shape(self.diagnostic, frame, self.thread_id, self.turn_id)
            if method == "remoteControl/status/changed":
                status = params.get("status") if type(params) is dict else None
                self.remote_control_status = status if type(status) is str and status in REMOTE_STATUSES - {"not_seen", "invalid"} else "invalid"
                if (type(params) is not dict or type(params.get("installationId")) is not str
                        or type(params.get("serverName")) is not str or self.remote_control_status == "invalid"
                        or params.get("environmentId") is not None and type(params["environmentId"]) is not str):
                    raise reviewed.Stop("PROTOCOL_REFUSED", site="event_params")
                # Pure disabled-status observation, never enable/disable/read.
                # Conservatively require no enrolled environment while disabled.
                if status != "disabled" or params.get("environmentId") is not None:
                    raise reviewed.Stop("CUSTODY_REFUSED", site="account_shape")
                return
            # Installed ServerNotification schema marks these as global metadata
            # or invalidation signals. They never authorize a tool or trigger a
            # refresh/action; existing per-event byte/count budgets still apply.
            if method in {"skills/changed", "app/list/updated", "mcpServer/startupStatus/updated"}:
                valid = type(params) is dict
                if valid and method == "skills/changed": valid = not params
                elif valid and method == "app/list/updated":
                    valid = type(params.get("data")) is list and all(_app_info(row) for row in params["data"])
                elif valid:
                    valid = (type(params.get("name")) is str and type(params.get("status")) is str
                        and params["status"] in {"starting", "ready", "failed", "cancelled"}
                        and params.get("failureReason") in (None, "reauthenticationRequired")
                        and (params.get("error") is None or type(params["error"]) is str)
                        and (params.get("threadId") is None or type(params["threadId"]) is str and params["threadId"] == self.thread_id))
                if not valid: raise reviewed.Stop("PROTOCOL_REFUSED", site="event_params")
                return
            if method in {"item/started", "item/completed"}:
                key = "startedAtMs" if method == "item/started" else "completedAtMs"
                require(type(params) is dict and type(params.get(key)) is int and params[key] >= 0, site="item_timestamp")
            if method == "serverRequest/resolved":
                require(type(params) is dict and set(params) == {"threadId", "requestId"} and params.get("threadId") == self.thread_id, site="resolved")
                key = self.engine._id_key(params.get("requestId"))
                require(key in self.engine._responded, site="resolved")
                return
            return super().event(frame)
    return Observer


class NativeConversation:
    """One custody-approved RPC, one ephemeral thread, serial bounded turns.

    tool({requestId, arguments, callId, threadId, turnId, tool, namespace}, timeout)
    returns native {success, contentItems}. requestId is exact Python str/int64.
    Host transport must tag int64 across JavaScript rather than round it.
    Exceptions after admission poison this session; never replay that input.
    The injected ports MUST enforce hard deadlines, including callback timeouts.
    extra_tools is a trusted source-owned list of {spec, validate}; validators
    must be pure/bounded, return exactly True, and must not mutate arguments.
    All registered tools share existing call/refusal/lifecycle byte budgets.
    thread_config optionally selects the exact trusted analysis overrides and
    three-tool registry; arbitrary configuration/web-enabled analysis is refused.
    """
    def __init__(self, canary_source, *, profile, cwd, tool_spec, instructions, rpc, tool, clock=time.monotonic, extra_tools=(), enable_web=False, thread_config=None):
        require(type(canary_source) is str and hashlib.sha256(canary_source.encode()).hexdigest().upper() == CANARY_SHA256, "CONFIG_REFUSED", "source")
        require(type(profile) is str and re.fullmatch(r"decadans-[a-z0-9][a-z0-9-]{0,110}", profile), "CONFIG_REFUSED", "config")
        require(type(cwd) is str and re.fullmatch(r"/run/decadans-[A-Za-z0-9_-]+/(?:allowed|workspace)", cwd), "CONFIG_REFUSED", "config")
        require(type(instructions) is str and 1 <= len(instructions.encode()) <= 4096, "CONFIG_REFUSED", "config")
        require(callable(tool) and callable(clock) and all(callable(getattr(rpc, key, None)) for key in ("exchange", "next_frame", "respond")), "CONFIG_REFUSED", "ports")
        require(type(enable_web) is bool, "CONFIG_REFUSED", "config")
        if thread_config is not None:
            require(type(thread_config) is dict and len(thread_config) == 2
                    and all(type(key) is str for key in thread_config)
                    and set(thread_config) == {"web_search", "features.image_generation"}
                    and type(thread_config["web_search"]) is str and thread_config["web_search"] == "disabled"
                    and thread_config["features.image_generation"] is False and not enable_web,
                    "CONFIG_REFUSED", "config")
        # Copy only pinned inert values; caller mutation cannot expand authority.
        self._thread_config = None if thread_config is None else {"web_search": "disabled", "features.image_generation": False}
        self._enable_web, self._web_counts = enable_web, web_counts()
        self._spec = validate_spec(tool_spec)
        self._specs, self._validators = extra_registry(extra_tools, self._spec)
        if self._thread_config is not None:
            require(tuple(self._validators) == (NAME, "neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"),
                    "CONFIG_REFUSED", "spec")
            self._specs = self._specs[1:]
            self._validators = {name: validator for name, validator in self._validators.items() if name != NAME}
        reviewed = types.ModuleType("native_conversation_reviewed_metadata")
        exec(compile(canary_source, "<reviewed-astra-v3>", "exec"), reviewed.__dict__)
        reviewed.ROOT, reviewed.ALLOWED, reviewed.PROFILE = cwd.rsplit("/", 1)[0], cwd, profile
        reviewed.ANSWER_CAP, reviewed.EVENT_CAP = ANSWER_CAP, EVENT_CAP
        reviewed.INSTRUCTIONS = instructions
        reviewed.METHOD_ENUMS = {name: name for name in OBSERVER_METHODS if name not in {"none", "other"}}
        self._reviewed, self._observer = reviewed, observer_class(reviewed)
        self._rpc, self._tool, self._clock = rpc, tool, clock
        self._thread, self._poisoned, self._turns = None, False, 0
        self._seen_ids, self._seen_calls, self._turn_ids, self._responded = set(), set(), set(), set()
        self._current_calls = {}
        self._analysis_reads = 0
        self._lock = threading.Lock()

    def state(self):
        return {"threadStarted": self._thread is not None, "poisoned": self._poisoned,
                "busy": self._lock.locked(), "turnsAttempted": self._turns, "toolCalls": len(self._seen_calls)}

    def tool_names(self):
        return tuple(self._validators)

    def web_metadata(self):
        """Current/last admitted turn counters; no URLs, results or delivery proof."""
        return dict(self._web_counts)

    def _registered(self, name):
        return type(name) is str and name in self._validators

    def _remaining(self, deadline):
        remaining = deadline - self._clock()
        require(remaining > 0, "TRANSPORT_UNKNOWN", "deadline")
        return remaining

    def _id_key(self, value):
        require(request_id(value), site="request_id")
        return (type(value).__name__, value)

    def _exchange(self, method, params, deadline):
        reply = self._rpc.exchange(method, params, min(20.0, self._remaining(deadline)))
        self._remaining(deadline)
        require(type(reply) is tuple and len(reply) == 2, site="exchange")
        result, error = reply
        require(error is None, "TURN_REFUSED", "exchange")
        require(type(result) is dict and len(encoded(result)) <= EVENT_BYTES_CAP, site="exchange")
        return result

    def _start(self, deadline):
        params = self._reviewed.thread_params()
        if self._thread_config is not None:
            params["config"] = {**params["config"], **self._thread_config}
        params["dynamicTools"] = json.loads(encoded(self._specs))
        reply = self._exchange("thread/start", params, deadline)
        thread, active = reply.get("thread"), reply.get("activePermissionProfile")
        require(type(thread) is dict and self._reviewed.opaque_id(thread.get("id")), site="thread_ack")
        require(reply.get("model") == "gpt-6-astra" and reply.get("modelProvider") == "openai" and reply.get("reasoningEffort") == "medium"
                and reply.get("cwd") == self._reviewed.ALLOWED and reply.get("approvalPolicy") == "never" and reply.get("approvalsReviewer") == "user"
                and type(active) is dict and active.get("id") == self._reviewed.PROFILE and thread.get("ephemeral") is True, "CONFIG_REFUSED", "thread_ack")
        self._thread = thread["id"]

    def _tool_content(self, content):
        require(type(content) is list and len(content) == 1, "TOOL_REFUSED", "tool_result")
        item = content[0]
        require(type(item) is dict and set(item) == {"type", "text"} and item["type"] == "inputText" and type(item["text"]) is str, "TOOL_REFUSED", "tool_result")
        require(len(item["text"].encode()) <= TOOL_TEXT_CAP, "BOUNDS_REFUSED", "tool_result")
        try: value = json.loads(item["text"], parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, TypeError): raise Refused("TOOL_REFUSED", "tool_result") from None
        require(type(value) is dict, "TOOL_REFUSED", "tool_result")

    def _count_frame(self, frame, receipt):
        # Registered results, validated text-file and isolated analysis-commit
        # payloads share the existing lifecycle budget. Count only a copy:
        # dispatch, correlation
        # and immutable lifecycle fingerprints still see the original bytes.
        # Envelopes, filenames, other arguments and agent text remain ordinary.
        ordinary = json.loads(encoded(frame))
        params = ordinary.get("params")
        items = []
        def count_text_payload(value):
            if type(value) is not dict or value.get('tool')!='neurobro_create_text_file' or not self._registered(value.get('tool')) or value.get('namespace') is not None:return
            args=value.get('arguments')
            if type(args) is not dict or set(args)!={'filename','text'} or type(args.get('text')) is not str:return
            try:
                if not 1<=len(args['text'].encode('utf-8'))<=65536:return
                candidate=json.loads(encoded(args));before=proof(candidate)
                if self._validators[value['tool']](candidate) is not True or proof(candidate)!=before:return
            except Exception:return
            receipt['historyLifecycleBytes']=min(HISTORY_LIFECYCLE_CAP+1,receipt['historyLifecycleBytes']+len(encoded(args['text']))-2)
            args['text']=''
        def count_analysis_payload(value):
            if self._thread_config is None or type(value) is not dict or value.get('tool')!='neurobro_analysis_commit' or not self._registered(value.get('tool')) or value.get('namespace') is not None:return
            args=value.get('arguments')
            if type(args) is not dict or set(args)!={'output'} or type(args['output']) is not dict:return
            try:
                candidate=json.loads(encoded(args));before=proof(candidate)
                if self._validators[value['tool']](candidate) is not True or proof(candidate)!=before:return
            except Exception:return
            receipt['historyLifecycleBytes']=min(HISTORY_LIFECYCLE_CAP+1,receipt['historyLifecycleBytes']+len(encoded(args['output']))-2)
            args['output']={}
        def count_payload(value):
            count_text_payload(value)
            count_analysis_payload(value)
        if type(params) is dict:
            if frame.get('method')=='item/tool/call':count_payload(params)
            if frame.get("method") in {"item/started", "item/completed"}: items = [params.get("item")]
            elif frame.get("method") in {"turn/started", "turn/completed"} and type(params.get("turn")) is dict and type(params["turn"].get("items")) is list:
                items = params["turn"]["items"]
        for item in items:
            if type(item) is dict and item.get('type')=='dynamicToolCall':count_payload(item)
            if type(item) is dict and item.get("type") == "dynamicToolCall" and self._registered(item.get("tool")) and item.get("namespace") is None and item.get("contentItems") is not None:
                self._tool_content(item["contentItems"])
                receipt["historyLifecycleBytes"] = min(HISTORY_LIFECYCLE_CAP + 1, receipt["historyLifecycleBytes"] + len(encoded(item["contentItems"])) - 2)
                item["contentItems"] = []
        receipt["eventBytes"] = min(EVENT_BYTES_CAP + 1, receipt["eventBytes"] + len(encoded(ordinary)))
        require(receipt["historyLifecycleBytes"] <= HISTORY_LIFECYCLE_CAP and receipt["eventBytes"] <= EVENT_BYTES_CAP, "BOUNDS_REFUSED", "events")

    def _request(self, frame, turn_id, deadline, receipt):
        require(set(frame) == {"id", "method", "params"} and frame.get("method") == "item/tool/call", "TOOL_REFUSED", "request")
        key = self._id_key(frame["id"])
        require(key not in self._seen_ids, "TOOL_REFUSED", "duplicate_request")
        p = frame["params"]
        require(type(p) is dict and set(p) in ({"arguments", "callId", "threadId", "turnId", "tool"}, {"arguments", "callId", "threadId", "turnId", "tool", "namespace"}), "TOOL_REFUSED", "request")
        require(p.get("threadId") == self._thread and p.get("turnId") == turn_id and self._registered(p.get("tool")) and p.get("namespace") is None, "TOOL_REFUSED", "correlation")
        require(self._reviewed.opaque_id(p.get("callId")) and p["callId"] not in self._seen_calls, "TOOL_REFUSED", "duplicate_call")
        self._seen_ids.add(key); self._seen_calls.add(p["callId"])
        refusal = None
        if p["tool"] == NAME:
            try: history_arguments(p["arguments"])
            except Refused: refusal = "invalid-arguments"
        else:
            try:
                args = json.loads(encoded(p["arguments"]))
                before = proof(args)
                require(type(args) is dict and self._validators[p["tool"]](args) is True and proof(args) == before, "TOOL_REFUSED", "arguments")
            except Exception: refusal = "invalid-arguments"
        if receipt["toolCalls"] >= TOOL_CALL_CAP or receipt["toolResultBytes"] + TOOL_REPLY_RESERVATION + (TOOL_REFUSAL_CAP - receipt["toolRefusals"]) * 1024 > TOOL_TURN_WIRE_CAP:
            refusal = "read-budget-exhausted" if p["tool"] == NAME else "tool-budget-exhausted"; receipt["toolBudgetExhausted"] = True
        analysis_read = self._thread_config is not None and p["tool"] in {"neurobro_analysis_material", "neurobro_analysis_notes"}
        if analysis_read and self._analysis_reads >= TOOL_CALL_CAP - 1:
            refusal = "tool-budget-exhausted"; receipt["toolBudgetExhausted"] = True
        if refusal is not None:
            require(receipt["toolRefusals"] < TOOL_REFUSAL_CAP, "BOUNDS_REFUSED", "tool_calls")
            receipt["toolRefusals"] += 1
            result = {"success": False, "contentItems": [{"type": "inputText", "text": json.dumps({"schema": "neurobro-history-tool-error-v1" if p["tool"] == NAME else "neurobro-tool-error-v1", "code": refusal}, separators=(",", ":"))}]}
        else:
            # Reserve maximum page wire before accessing a cursor/page. The
            # actual result replaces this reservation only after validation.
            receipt["toolCalls"] += 1
            if analysis_read: self._analysis_reads += 1
            callback = {**json.loads(encoded(p)), "namespace": None, "requestId": frame["id"]}
            result = self._tool(callback, min(20.0, self._remaining(deadline)))
            self._remaining(deadline)
        require(type(result) is dict and set(result) == {"success", "contentItems"} and type(result["success"]) is bool, "TOOL_REFUSED", "tool_result")
        self._tool_content(result["contentItems"])
        wire = encoded({"id": frame["id"], "result": result})
        require(len(wire) <= TOOL_REPLY_RESERVATION and receipt["toolResultBytes"] + len(wire) <= TOOL_TURN_WIRE_CAP, "BOUNDS_REFUSED", "tool_wire")
        receipt["toolResultBytes"] += len(wire)
        self._rpc.respond(frame["id"], json.loads(encoded(result)), min(20.0, self._remaining(deadline)))
        self._remaining(deadline)
        self._responded.add(key)
        fingerprint = proof({"arguments": p["arguments"], "tool": p["tool"], "namespace": p.get("namespace")})
        self._current_calls[p["callId"]] = (fingerprint, result["success"], proof(result["contentItems"]))

    def _turn_deadline(self):
        # Explicit specialized profiles may override this without changing the
        # text engine's default or mutating a shared module/global clock.
        return self._clock() + WORK_SECONDS

    def run(self, text):
        receipt = metadata()
        if not self._lock.acquire(blocking=False):
            receipt["code"] = "BUSY"; return {"answer": None, "metadata": receipt}
        admitted, observer = False, None
        try:
            receipt.update(threadStarted=self._thread is not None, sessionPoisoned=self._poisoned, turnNumber=self._turns)
            if self._poisoned:
                receipt["code"] = "SESSION_POISONED"; return {"answer": None, "metadata": receipt}
            require(self._turns < SESSION_TURN_CAP, "SESSION_LIMIT", "session")
            require(type(text) is str and text.strip() and "\x00" not in text, "INPUT_REFUSED", "input")
            size = len(text.encode())
            require(1 <= size <= INPUT_CAP, "INPUT_REFUSED", "input")
            receipt["inputBytes"] = size
            deadline = self._turn_deadline()
            self._web_counts = web_counts()
            admitted = True
            if self._thread is None:
                receipt["stage"] = "thread"; self._start(deadline)
            self._turns += 1
            self._current_calls = {}
            self._analysis_reads = 0
            receipt.update(threadStarted=True, turnNumber=self._turns, turnAttempted=True, stage="turn")
            params = self._reviewed.turn_params(self._thread)
            params["input"] = [{"type": "text", "text": text, "text_elements": []}]
            turn = self._exchange("turn/start", params, deadline).get("turn")
            require(type(turn) is dict and self._reviewed.opaque_id(turn.get("id")) and turn["id"] not in self._turn_ids, site="turn_ack")
            self._turn_ids.add(turn["id"])
            counts = {**dict.fromkeys(self._reviewed.BOOL_KEYS, False), **dict.fromkeys(self._reviewed.COUNT_KEYS, 0)}
            observer = self._observer(self, counts, turn["id"])
            observer.turn(turn, False)
            receipt["stage"] = "completion"
            while not counts["turnCompleted"]:
                frame = self._rpc.next_frame(self._remaining(deadline))
                self._remaining(deadline)
                require(type(frame) is dict, "TRANSPORT_UNKNOWN", "frame")
                receipt["eventCount"] += 1
                self._count_frame(frame, receipt)
                require(receipt["eventCount"] <= EVENT_CAP and receipt["eventBytes"] <= EVENT_BYTES_CAP, "BOUNDS_REFUSED", "events")
                if "id" in frame: self._request(frame, turn["id"], deadline, receipt)
                else: observer.event(frame)
            receipt["observer"]["remoteControlStatus"] = observer.remote_control_status
            receipt.update(outcome="observed", code="OK", stage="complete", turnCompleted=True, answerBytes=len(observer.answer.encode()))
            return {"answer": observer.answer, "metadata": receipt}
        except Exception as error:
            code = getattr(error, "code", None)
            safe_codes = {"CONFIG_REFUSED", "INPUT_REFUSED", "SESSION_LIMIT", "PROTOCOL_REFUSED", "TOOL_REFUSED", "ANSWER_REFUSED", "TURN_REFUSED", "BOUNDS_REFUSED", "TRANSPORT_UNKNOWN", "THREAD_REFUSED", "CUSTODY_REFUSED", "TOOL_EVENT_REFUSED"}
            if type(code) is not str or code not in safe_codes: code = "TRANSPORT_UNKNOWN"
            if admitted: self._poisoned = True
            # Only the exact pinned observer's exception class may supply its
            # fixed site/method/shape. No raw diagnostics or arbitrary adapter
            # exception attributes are promoted into the receipt.
            if observer is not None and isinstance(error, self._reviewed.Stop):
                d = observer.diagnostic
                receipt["observer"] = {
                    "site": error.site if type(error.site) is str and error.site in OBSERVER_SITES else "none",
                    "method": d["method"] if type(d["method"]) is str and d["method"] in OBSERVER_METHODS else "other",
                    "shape": {key: d["shape"].get(key) is True for key in OBSERVER_SHAPES}, "remoteControlStatus": observer.remote_control_status}
            if observer is not None: receipt["observer"]["remoteControlStatus"] = observer.remote_control_status
            # Native failure-site behavior remains unchanged.
            sites = {"frame", "spec", "config", "ports", "source", "input", "session", "arguments", "item", "tool_item", "tool_item_correlation", "tool_item_result", "tool_item_changed", "tool_item_missing", "answer", "answer_changed", "answer_missing", "turn", "item_timestamp", "resolved", "deadline", "request_id", "exchange", "thread_ack", "tool_result", "request", "duplicate_request", "correlation", "duplicate_call", "tool_calls", "tool_wire", "turn_ack", "events", "web_item", "web_changed", "web_unfinished"}
            site = error.site if isinstance(error, Refused) and type(error.site) is str and error.site in sites else "observer_or_transport"
            receipt["toolBudgetExhausted"] = receipt["toolBudgetExhausted"] or code == "BOUNDS_REFUSED" and site in {"tool_calls", "tool_wire", "tool_result"}
            receipt.update(outcome="unknown" if admitted else "refused", code=code, failureSite=site, sessionPoisoned=self._poisoned)
            return {"answer": None, "metadata": receipt}
        finally:
            self._lock.release()
