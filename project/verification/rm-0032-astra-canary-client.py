"""Offline-reviewed candidate for one synthetic Astra turn, never Telegram.

The caller injects the exact frozen custody source; this module does not locate
files, import a runtime installation, or launch anything at import time.
"""
import hashlib
import json
import queue
import subprocess
import sys
import time
import types

BASE_SHA256 = "6A5F187C701708830B8556465DDEA0142196250302A1062C6E343C3F7BA598E9"
SCHEMA = "decadans.rm0032.astra-canary-client.v1"
ROOT = "/run/decadans-astra-canary-20260910-v3"
ALLOWED = ROOT + "/allowed"
PROFILE = "decadans-astra-canary-v3"
MODEL = "gpt-6-astra"
EFFORT = "medium"
ANSWER = "NEUROBRO_ASTRA_READY."
PROMPT = "Return exactly the text inside <answer> tags, without tags or any other characters: <answer>NEUROBRO_ASTRA_READY.</answer>"
INSTRUCTIONS = "This is a synthetic connectivity check. Return only the requested literal text. Do not invoke any tools, access files, delegate, or request user input."
ANSWER_CAP = 256
EVENT_CAP = 128
EVENT_BYTES_CAP = 262144
WORK_SECONDS = 125.0
CUSTODY_KEYS = ("initialize", "profile", "controls", "probes", "account", "model")
BOOL_KEYS = ("threadAttempted", "threadStarted", "turnAttempted", "turnStarted", "modelMatched", "effortMatched", "permissionsMatched", "ephemeralMatched", "turnCompleted", "answerExact")
COUNT_KEYS = ("answerBytes", "toolEvents", "serverRequests", "events")
CODES = frozenset(("NOT_RUN", "OK", "CUSTODY_REFUSED", "THREAD_REFUSED", "TURN_REFUSED", "PROTOCOL_REFUSED", "TOOL_EVENT_REFUSED", "TOOL_REQUEST_REFUSED", "ANSWER_REFUSED", "BOUNDS_REFUSED", "TRANSPORT_UNKNOWN", "SHUTDOWN_UNKNOWN", "INTERNAL_UNKNOWN"))
STAGES = frozenset(("custody", "thread", "turn", "completion", "shutdown", "complete"))
FAILURE_SITES = frozenset(("none", "rpc_json", "rpc_frame", "notification_shape", "notification_item", "rpc_method", "rpc_budget", "rpc_after_model", "rpc_id", "rpc_result", "notification_expected", "item_shape", "item_text", "item_utf8", "item_conflict", "turn_shape", "event_params", "thread_event", "thread_id", "turn_id", "delta_shape", "delta_utf8", "thread_response", "turn_response", "warning_shape", "status_shape", "settings_shape", "account_shape", "model_metadata_shape", "error_shape", "base_protocol"))
METHOD_ENUMS = {name: name for name in (
    "initialize", "permissionProfile/list", "command/exec", "account/read", "model/list", "thread/start", "turn/start",
    "thread/started", "thread/status/changed", "thread/tokenUsage/updated", "thread/queue/changed", "thread/settings/updated",
    "account/updated", "account/rateLimits/updated", "configWarning", "deprecationNotice", "warning", "guardianWarning",
    "turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded",
    "model/rerouted", "model/verification", "model/safetyBuffering/updated", "error",
    "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted")}
SHAPE_KEYS = ("paramsObject", "threadIdPresent", "threadIdMatched", "turnIdPresent", "turnIdMatched", "nestedThreadObject", "nestedTurnObject", "nestedItemObject", "turnItemsList", "threadEphemeralPresent", "threadEphemeralTrue")
ERROR_CODES = frozenset(("none", "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded", "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "internalServerError", "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "other", "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts", "activeTurnNotSteerable"))
ERROR_CATEGORIES = frozenset(("none", "quota", "auth", "rate_limit", "network", "provider", "bad_request", "policy", "context", "budget", "sandbox", "resource_unavailable", "other"))
# Verified against rust-v0.153.4 core/config.schema.json and tools/spec_plan.rs.
# Empty environments removes execution/file tools, independently of these flags.
DISABLED_FEATURES = ("shell_tool", "view_image", "apps", "plugins", "code_mode", "code_mode_only", "multi_agent", "multi_agent_v2", "image_generation", "sleep_tool", "memory_tool", "browser_use", "js_repl", "deferred_executor", "request_permissions_tool")


class Stop(Exception):
    def __init__(self, code, unknown=False, site="none"):
        self.code = code if code in CODES else "INTERNAL_UNKNOWN"
        self.unknown = unknown
        self.site = site if site in FAILURE_SITES else "none"


def diagnostic_result():
    return {"failureSite": "none", "method": "none", "shape": dict.fromkeys(SHAPE_KEYS, False),
            "providerError": {"category": "none", "code": "none", "httpStatus": None, "willRetry": None},
            "rpcErrorCode": None,
            "metadataCounts": dict.fromkeys(("queue", "settings", "account", "configWarning", "deprecationNotice", "warning", "modelVerification", "modelSafety", "authRecovery", "retryNotice"), 0)}


def provider_error(diagnostic, error, will_retry=None):
    if not isinstance(error, dict) or not isinstance(error.get("message"), str):
        raise Stop("PROTOCOL_REFUSED", site="error_shape")
    info, code, status = error.get("codexErrorInfo"), "other", None
    if isinstance(info, str) and info in ERROR_CODES: code = info
    elif isinstance(info, dict) and len(info) == 1:
        key = next(iter(info))
        if key in ERROR_CODES and isinstance(info[key], dict):
            code = key
            status = info[key].get("httpStatusCode")
            if status is not None and (type(status) is not int or not 100 <= status <= 599):
                raise Stop("PROTOCOL_REFUSED", site="error_shape")
    category = {"usageLimitExceeded": "quota", "sessionBudgetExceeded": "budget", "rateLimitExceeded": "rate_limit", "unauthorized": "auth", "badRequest": "bad_request", "contextWindowExceeded": "context", "sandboxError": "sandbox", "cyberPolicy": "policy", "misalignmentPolicyViolation": "policy", "serverOverloaded": "provider", "internalServerError": "provider", "httpConnectionFailed": "network", "responseStreamConnectionFailed": "network", "responseStreamDisconnected": "network", "responseTooManyFailedAttempts": "network"}.get(code, "other")
    if status in {401, 403}: category = "auth"
    elif status == 429: category = "rate_limit"
    elif status == 404: category = "resource_unavailable"
    elif status is not None and status >= 500: category = "provider"
    diagnostic["providerError"] = {"category": category, "code": code, "httpStatus": status, "willRetry": will_retry}


def diagnostic_shape(diagnostic, frame, thread_id=None, turn_id=None):
    if isinstance(frame, dict) and "method" in frame:
        diagnostic["method"] = METHOD_ENUMS.get(frame["method"], "unknown") if isinstance(frame["method"], str) else "unknown"
    params = frame.get("params") if isinstance(frame, dict) else None
    shape = dict.fromkeys(SHAPE_KEYS, False)
    if isinstance(params, dict):
        shape.update(paramsObject=True, threadIdPresent="threadId" in params,
                     threadIdMatched=thread_id is not None and params.get("threadId") == thread_id,
                     turnIdPresent="turnId" in params,
                     turnIdMatched=turn_id is not None and params.get("turnId") == turn_id,
                     nestedThreadObject=isinstance(params.get("thread"), dict),
                     nestedTurnObject=isinstance(params.get("turn"), dict),
                     nestedItemObject=isinstance(params.get("item"), dict))
        if shape["nestedTurnObject"]: shape["turnItemsList"] = isinstance(params["turn"].get("items"), list)
        if shape["nestedThreadObject"]:
            shape["threadEphemeralPresent"] = "ephemeral" in params["thread"]
            shape["threadEphemeralTrue"] = params["thread"].get("ephemeral") is True
    diagnostic["shape"] = shape


def load_base(source):
    if not isinstance(source, str) or hashlib.sha256(source.encode("utf-8")).hexdigest().upper() != BASE_SHA256:
        raise ValueError("base-source-refused")
    module = types.ModuleType("reviewed_custody_source")
    exec(compile(source, "<reviewed-custody-source>", "exec"), module.__dict__)
    # Functions retain this private namespace. No frozen file is edited.
    module.ROOT, module.ALLOWED, module.PROFILE = ROOT, ALLOWED, PROFILE
    return module


def base_result(base):
    custody = base.base_result()
    return {"schema": SCHEMA, "outcome": "unknown", "stage": "custody", "code": "NOT_RUN",
            "custody": {k: custody[k] for k in CUSTODY_KEYS}, "appServer": custody["appServer"],
            "canary": {**{k: False for k in BOOL_KEYS}, **{k: 0 for k in COUNT_KEYS}},
            "diagnostic": diagnostic_result(),
            "limits": {"clientTurnStartLimit": 1, "transportRetriesDisabled": False,
                       "syntheticInputOnly": True, "telegram": False}}


def custody_ready(custody, after=False):
    controls = custody["controls"]
    return (custody["initialize"] and custody["profile"]
            and all(v for k, v in controls.items() if after or k != "relayAfter")
            and all(p["verdict"] == "pass" for p in custody["probes"])
            and all(custody["account"].values())
            and all(custody["model"][k] for k in ("checked", "astraListedOnce", "mediumSupported")))


def normalize_result(value, base_source):
    base = load_base(base_source)
    template = base_result(base)
    if not isinstance(value, dict) or set(value) != set(template) or value["schema"] != SCHEMA:
        raise ValueError("invalid-result")
    if value["outcome"] not in {"observed", "refused", "unknown"} or value["stage"] not in STAGES or value["code"] not in CODES:
        raise ValueError("invalid-disposition")
    if not isinstance(value["custody"], dict) or set(value["custody"]) != set(CUSTODY_KEYS):
        raise ValueError("invalid-custody-checks")
    projection = base.base_result()
    projection.update(value["custody"])
    projection["appServer"] = value["appServer"]
    base.normalize_result(projection)
    if value["limits"] != template["limits"] or any(type(value["limits"][k]) is not type(template["limits"][k]) for k in template["limits"]):
        raise ValueError("invalid-limits")
    diagnostic = value["diagnostic"]
    diagnostic_template = template["diagnostic"]
    if not isinstance(diagnostic, dict) or set(diagnostic) != set(diagnostic_template) or diagnostic["failureSite"] not in FAILURE_SITES or diagnostic["method"] not in {*METHOD_ENUMS, "none", "unknown"}:
        raise ValueError("invalid-diagnostic")
    if not isinstance(diagnostic["shape"], dict) or set(diagnostic["shape"]) != set(SHAPE_KEYS) or any(type(v) is not bool for v in diagnostic["shape"].values()):
        raise ValueError("invalid-diagnostic-shape")
    if not isinstance(diagnostic["metadataCounts"], dict) or set(diagnostic["metadataCounts"]) != set(diagnostic_template["metadataCounts"]) or any(not base.integer(v) or not 0 <= v <= EVENT_CAP for v in diagnostic["metadataCounts"].values()):
        raise ValueError("invalid-diagnostic-count")
    error = diagnostic["providerError"]
    if not isinstance(error, dict) or set(error) != set(diagnostic_template["providerError"]) or error["category"] not in ERROR_CATEGORIES or error["code"] not in ERROR_CODES or (error["httpStatus"] is not None and (type(error["httpStatus"]) is not int or not 100 <= error["httpStatus"] <= 599)) or (error["willRetry"] is not None and type(error["willRetry"]) is not bool):
        raise ValueError("invalid-provider-error")
    if diagnostic["rpcErrorCode"] is not None and not base.integer(diagnostic["rpcErrorCode"]): raise ValueError("invalid-rpc-error")
    if value["code"] == "PROTOCOL_REFUSED" and diagnostic["failureSite"] == "none": raise ValueError("missing-failure-site")
    canary = value["canary"]
    if not isinstance(canary, dict) or set(canary) != set(template["canary"]) or any(type(canary[k]) is not bool for k in BOOL_KEYS):
        raise ValueError("invalid-canary")
    for k in COUNT_KEYS:
        if not base.integer(canary[k]) or not 0 <= canary[k] <= (ANSWER_CAP + 1 if k == "answerBytes" else EVENT_CAP + 1):
            raise ValueError("invalid-count")
    if canary["threadStarted"] and not canary["threadAttempted"]: raise ValueError("thread-attempt-missing")
    if canary["turnAttempted"] and not (canary["threadStarted"] and custody_ready(value["custody"])): raise ValueError("turn-without-proof")
    if canary["turnStarted"] and not canary["turnAttempted"]: raise ValueError("turn-attempt-missing")
    if canary["turnCompleted"] and not canary["turnStarted"]: raise ValueError("turn-start-missing")
    if canary["answerExact"] and canary["answerBytes"] != len(ANSWER.encode()): raise ValueError("invalid-answer-proof")
    if value["outcome"] == "observed":
        app = value["appServer"]
        if value["stage"] != "complete" or value["code"] != "OK" or not custody_ready(value["custody"], after=True) or not all(canary[k] for k in BOOL_KEYS) or canary["toolEvents"] or canary["serverRequests"] or not all(app[k] for k in ("launched", "stdinClosed", "reaped", "stderrComplete")) or app["exitCode"] != 0 or app["stderrBytes"] > base.STDERR_CAP:
            raise ValueError("invalid-observed")
    return json.loads(json.dumps(value, sort_keys=True))


def launch_argv(base):
    argv = base.app_server_argv()
    extra = ["model='gpt-6-astra'", "model_reasoning_effort='medium'", "web_search='disabled'",
             "agents.enabled=false", "tools.update_plan.enabled=false", "tools.experimental_request_user_input.enabled=false"]
    extra += [f"features.{name}=false" for name in DISABLED_FEATURES]
    return argv[:-1] + [arg for config in extra for arg in ("-c", config)] + argv[-1:]


def thread_params():
    return {"model": MODEL, "modelProvider": "openai", "allowProviderModelFallback": False,
            "ephemeral": True, "cwd": ALLOWED, "permissions": PROFILE, "approvalPolicy": "never",
            "approvalsReviewer": "user", "environments": [], "dynamicTools": [],
            "selectedCapabilityRoots": [], "runtimeWorkspaceRoots": [ALLOWED],
            "baseInstructions": INSTRUCTIONS, "developerInstructions": INSTRUCTIONS,
            "experimentalRawEvents": False, "config": {"model_reasoning_effort": EFFORT}}


def turn_params(thread_id):
    return {"threadId": thread_id, "input": [{"type": "text", "text": PROMPT, "text_elements": []}],
            "model": MODEL, "effort": EFFORT, "summary": "none", "cwd": ALLOWED,
            "permissions": PROFILE, "approvalPolicy": "never", "approvalsReviewer": "user",
            "environments": [], "runtimeWorkspaceRoots": [ALLOWED]}


def rpc_class(base):
    class CanaryRpc(base.Rpc):
        def __init__(self, proc, deadline, canary, diagnostic=None):
            self.canary = canary
            self.diagnostic = diagnostic_result() if diagnostic is None else diagnostic
            self.model_mode = False
            self.notifications = []
            self.notification_bytes = 0
            self.model_counts = {"thread/start": 0, "turn/start": 0}
            super().__init__(proc, deadline)

        def receive(self, deadline):
            remaining = min(self.deadline, deadline) - time.monotonic()
            if remaining <= 0 or self.failed.is_set(): raise Stop("TRANSPORT_UNKNOWN", True)
            try: line = self.items.get(timeout=remaining)
            except queue.Empty: raise Stop("TRANSPORT_UNKNOWN", True) from None
            if line is None: raise Stop("TRANSPORT_UNKNOWN", True)
            try: frame = json.loads(line.decode("utf-8"), object_pairs_hook=base._unique_pairs)
            except Exception: raise Stop("PROTOCOL_REFUSED", site="rpc_json") from None
            diagnostic_shape(self.diagnostic, frame)
            if not isinstance(frame, dict): raise Stop("PROTOCOL_REFUSED", site="rpc_frame")
            if "method" in frame and "id" in frame:
                self.canary["serverRequests"] += 1
                raise Stop("TOOL_REQUEST_REFUSED")
            return frame, len(line)

        def collect_notification(self, frame, size):
            if not isinstance(frame.get("method"), str) or not isinstance(frame.get("params"), dict):
                raise Stop("PROTOCOL_REFUSED", site="notification_shape")
            if not self.model_mode: return
            method, params = frame["method"], frame["params"]
            if method in {"item/started", "item/completed"}:
                item = params.get("item")
                if not isinstance(item, dict): raise Stop("PROTOCOL_REFUSED", site="notification_item")
                if item.get("type") not in {"userMessage", "agentMessage", "reasoning"}:
                    self.canary["toolEvents"] += 1
                    raise Stop("TOOL_EVENT_REFUSED")
            self.canary["events"] = min(EVENT_CAP + 1, self.canary["events"] + 1)
            self.notification_bytes += size
            if self.canary["events"] > EVENT_CAP or self.notification_bytes > EVENT_BYTES_CAP:
                raise Stop("BOUNDS_REFUSED")
            self.notifications.append(frame)

        def exchange(self, method, params, seconds=10.0):
            diagnostic_shape(self.diagnostic, {"method": method, "params": params})
            if method not in base.METHODS and method not in self.model_counts: raise Stop("PROTOCOL_REFUSED", site="rpc_method")
            if method in self.model_counts:
                if not self.model_mode or self.model_counts[method] != 0: raise Stop("PROTOCOL_REFUSED", site="rpc_budget")
                self.model_counts[method] += 1  # A failed or unknown request is consumed.
            elif self.model_mode:
                raise Stop("PROTOCOL_REFUSED", site="rpc_after_model")
            request_id = self.next_id
            self.next_id += 1
            self._write({"id": request_id, "method": method, "params": params})
            deadline = min(self.deadline, time.monotonic() + seconds)
            while True:
                frame, size = self.receive(deadline)
                if "id" not in frame:
                    self.collect_notification(frame, size)
                    continue
                if not base.integer(frame.get("id")) or frame["id"] != request_id: raise Stop("PROTOCOL_REFUSED", site="rpc_id")
                if "error" in frame and "result" not in frame and isinstance(frame["error"], dict) and base.integer(frame["error"].get("code")):
                    self.diagnostic["rpcErrorCode"] = frame["error"]["code"]
                    return None, frame["error"]["code"]
                if "error" not in frame and isinstance(frame.get("result"), dict): return frame["result"], None
                raise Stop("PROTOCOL_REFUSED", site="rpc_result")

        def next_notification(self):
            if self.notifications: return self.notifications.pop(0)
            frame, size = self.receive(self.deadline)
            if "id" in frame: raise Stop("PROTOCOL_REFUSED", site="notification_expected")
            self.collect_notification(frame, size)
            return self.notifications.pop(0)
    return CanaryRpc


def opaque_id(value):
    return isinstance(value, str) and 0 < len(value) <= 128 and not any(c.isspace() for c in value)


class Observer:
    def __init__(self, canary, thread_id, turn_id, diagnostic=None):
        self.canary, self.thread_id, self.turn_id = canary, thread_id, turn_id
        self.diagnostic = diagnostic_result() if diagnostic is None else diagnostic
        self.finished_agents = {}
        self.delta_bytes = 0

    def item(self, item, completed):
        if not isinstance(item, dict) or not opaque_id(item.get("id")): raise Stop("PROTOCOL_REFUSED", site="item_shape")
        kind = item.get("type")
        if kind not in {"userMessage", "agentMessage", "reasoning"}:
            self.canary["toolEvents"] += 1
            raise Stop("TOOL_EVENT_REFUSED")
        if kind == "agentMessage" and completed:
            text = item.get("text")
            if not isinstance(text, str): raise Stop("PROTOCOL_REFUSED", site="item_text")
            try: size = len(text.encode("utf-8"))
            except UnicodeError: raise Stop("PROTOCOL_REFUSED", site="item_utf8") from None
            if size > ANSWER_CAP:
                self.canary["answerBytes"] = ANSWER_CAP + 1
                raise Stop("BOUNDS_REFUSED")
            proof = (size, text == ANSWER)
            prior = self.finished_agents.get(item["id"])
            if prior is not None and prior != proof: raise Stop("PROTOCOL_REFUSED", site="item_conflict")
            self.finished_agents[item["id"]] = proof
            if len(self.finished_agents) > 1: raise Stop("ANSWER_REFUSED")
            self.canary["answerBytes"], self.canary["answerExact"] = proof

    def turn(self, turn, completed):
        if not isinstance(turn, dict) or turn.get("id") != self.turn_id or not isinstance(turn.get("items"), list):
            raise Stop("PROTOCOL_REFUSED", site="turn_shape")
        if len(turn["items"]) > EVENT_CAP: raise Stop("BOUNDS_REFUSED")
        for item in turn["items"]: self.item(item, completed)
        if completed:
            if turn.get("error") is not None: provider_error(self.diagnostic, turn["error"], False)
            if turn.get("status") != "completed" or turn.get("error") is not None: raise Stop("TURN_REFUSED")
            self.canary["turnCompleted"] = True
            if len(self.finished_agents) != 1 or not self.canary["answerExact"]: raise Stop("ANSWER_REFUSED")

    def event(self, frame):
        diagnostic_shape(self.diagnostic, frame, self.thread_id, self.turn_id)
        method, params = frame.get("method"), frame.get("params")
        if not isinstance(params, dict): raise Stop("PROTOCOL_REFUSED", site="event_params")
        counts = self.diagnostic["metadataCounts"]
        if method == "thread/started":
            thread = params.get("thread")
            if not isinstance(thread, dict) or thread.get("id") != self.thread_id or thread.get("ephemeral") is not True:
                raise Stop("PROTOCOL_REFUSED", site="thread_event")
            return
        # These exact schemas have no required thread/turn association. Contents
        # remain ephemeral; only the fixed notification kind is counted.
        if method in {"configWarning", "deprecationNotice"}:
            if not isinstance(params.get("summary"), str) or (params.get("details") is not None and not isinstance(params["details"], str)):
                raise Stop("PROTOCOL_REFUSED", site="warning_shape")
            counts[method] += 1
            return
        if method in {"warning", "guardianWarning"}:
            if not isinstance(params.get("message"), str): raise Stop("PROTOCOL_REFUSED", site="warning_shape")
            if method == "guardianWarning" or params.get("threadId") is not None:
                if params.get("threadId") != self.thread_id: raise Stop("PROTOCOL_REFUSED", site="thread_id")
            counts["warning"] += 1
            return
        if method == "account/updated":
            if params.get("authMode") != "chatgpt": raise Stop("CUSTODY_REFUSED", site="account_shape")
            if params.get("planType") is not None and not isinstance(params["planType"], str): raise Stop("PROTOCOL_REFUSED", site="account_shape")
            counts["account"] += 1
            return
        if method == "account/rateLimits/updated":
            return
        if params.get("threadId") != self.thread_id: raise Stop("PROTOCOL_REFUSED", site="thread_id")
        if method == "thread/status/changed":
            status = params.get("status")
            if not isinstance(status, dict) or status.get("type") not in {"notLoaded", "idle", "systemError", "active"} or (status["type"] == "active" and not isinstance(status.get("activeFlags"), list)):
                raise Stop("PROTOCOL_REFUSED", site="status_shape")
            return
        if method == "thread/tokenUsage/updated": return
        if method == "thread/queue/changed":
            counts["queue"] += 1
            return
        if method == "thread/settings/updated":
            settings = params.get("threadSettings")
            if not isinstance(settings, dict): raise Stop("PROTOCOL_REFUSED", site="settings_shape")
            profile = settings.get("activePermissionProfile")
            if settings.get("model") != MODEL or settings.get("modelProvider") != "openai" or settings.get("effort") != EFFORT or settings.get("cwd") != ALLOWED or settings.get("approvalPolicy") != "never" or settings.get("approvalsReviewer") != "user" or not isinstance(profile, dict) or profile.get("id") != PROFILE:
                raise Stop("THREAD_REFUSED", site="settings_shape")
            counts["settings"] += 1
            return
        if method in {"turn/started", "turn/completed"}:
            self.turn(params.get("turn"), method == "turn/completed")
            return
        if params.get("turnId") != self.turn_id: raise Stop("PROTOCOL_REFUSED", site="turn_id")
        if method == "model/rerouted":
            # A fixed-model canary never accepts a reroute, even if it later reverts.
            raise Stop("TURN_REFUSED", site="model_metadata_shape")
        if method == "model/verification":
            if not isinstance(params.get("verifications"), list) or any(v != "trustedAccessForCyber" for v in params["verifications"]):
                raise Stop("PROTOCOL_REFUSED", site="model_metadata_shape")
            counts["modelVerification"] += 1
            return
        if method == "model/safetyBuffering/updated":
            if params.get("model") != MODEL: raise Stop("TURN_REFUSED", site="model_metadata_shape")
            if type(params.get("showBufferingUi")) is not bool or any(not isinstance(params.get(k), list) or any(not isinstance(v, str) for v in params[k]) for k in ("reasons", "useCases")):
                raise Stop("PROTOCOL_REFUSED", site="model_metadata_shape")
            counts["modelSafety"] += 1
            return
        if method in {"modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted"}:
            if params.get("provider") != "openai" or not isinstance(params.get("message"), str): raise Stop("PROTOCOL_REFUSED", site="model_metadata_shape")
            counts["authRecovery"] += 1
            return
        if method == "error":
            if type(params.get("willRetry")) is not bool or not isinstance(params.get("error"), dict): raise Stop("PROTOCOL_REFUSED", site="error_shape")
            provider_error(self.diagnostic, params["error"], params["willRetry"])
            if not params["willRetry"]: raise Stop("TURN_REFUSED", site="error_shape")
            counts["retryNotice"] += 1
            return
        if method in {"item/started", "item/completed"}:
            self.item(params.get("item"), method == "item/completed")
            return
        if method == "item/agentMessage/delta":
            delta = params.get("delta")
            if not isinstance(delta, str): raise Stop("PROTOCOL_REFUSED", site="delta_shape")
            try: self.delta_bytes += len(delta.encode("utf-8"))
            except UnicodeError: raise Stop("PROTOCOL_REFUSED", site="delta_utf8") from None
            if self.delta_bytes > ANSWER_CAP: raise Stop("BOUNDS_REFUSED")
            return
        if method in {"item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded"}: return
        self.canary["toolEvents"] += 1
        raise Stop("TOOL_EVENT_REFUSED")


def model_protocol(rpc, result):
    if not custody_ready(result["custody"]): raise Stop("CUSTODY_REFUSED")
    canary = result["canary"]
    rpc.model_mode = True
    result["stage"] = "thread"
    canary["threadAttempted"] = True
    thread, error = rpc.exchange("thread/start", thread_params(), 20.0)
    if error is not None: raise Stop("THREAD_REFUSED")
    body = thread.get("thread")
    diagnostic_shape(result["diagnostic"], {"method": "thread/start", "params": {"thread": body}})
    if not isinstance(body, dict) or not opaque_id(body.get("id")): raise Stop("PROTOCOL_REFUSED", site="thread_response")
    thread_id = body["id"]
    canary["threadStarted"] = True
    canary["modelMatched"] = thread.get("model") == MODEL and thread.get("modelProvider") == "openai"
    canary["effortMatched"] = thread.get("reasoningEffort") == EFFORT
    profile = thread.get("activePermissionProfile")
    canary["permissionsMatched"] = isinstance(profile, dict) and profile.get("id") == PROFILE and thread.get("cwd") == ALLOWED and thread.get("approvalPolicy") == "never"
    canary["ephemeralMatched"] = body.get("ephemeral") is True
    if not all(canary[k] for k in ("modelMatched", "effortMatched", "permissionsMatched", "ephemeralMatched")):
        raise Stop("THREAD_REFUSED")
    result["stage"] = "turn"
    canary["turnAttempted"] = True
    started, error = rpc.exchange("turn/start", turn_params(thread_id), 20.0)
    if error is not None: raise Stop("TURN_REFUSED")
    turn = started.get("turn")
    diagnostic_shape(result["diagnostic"], {"method": "turn/start", "params": {"turn": turn}})
    if not isinstance(turn, dict) or not opaque_id(turn.get("id")): raise Stop("PROTOCOL_REFUSED", site="turn_response")
    canary["turnStarted"] = True
    observer = Observer(canary, thread_id, turn["id"], result["diagnostic"])
    observer.turn(turn, False)
    result["stage"] = "completion"
    while not canary["turnCompleted"]:
        observer.event(rpc.next_notification())


def run(base_source):
    base = load_base(base_source)
    result, proc, stderr = base_result(base), None, None
    custody = base.base_result()
    deadline = time.monotonic() + WORK_SECONDS
    try:
        base.preflight(custody)
        proc = subprocess.Popen(launch_argv(base), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=ALLOWED, env=base.app_server_env(), close_fds=True, bufsize=0)
        result["appServer"]["launched"] = True
        stderr = base.StderrDigest(proc.stderr)
        rpc = rpc_class(base)(proc, deadline, result["canary"], result["diagnostic"])
        base.protocol(rpc, custody, proc.pid)
        result["custody"] = {k: custody[k] for k in CUSTODY_KEYS}
        model_protocol(rpc, result)
        result.update(outcome="observed", stage="complete", code="OK")
    except Stop as exc:
        result.update(outcome="unknown" if exc.unknown else "refused", code=exc.code)
        result["diagnostic"]["failureSite"] = exc.site
    except base.Stop as exc:
        result.update(outcome="unknown" if exc.unknown else "refused", code="TRANSPORT_UNKNOWN" if exc.unknown else "CUSTODY_REFUSED")
        result["diagnostic"]["failureSite"] = "base_protocol"
    except Exception:
        result.update(outcome="unknown", code="INTERNAL_UNKNOWN")
    finally:
        result["custody"] = {k: custody[k] for k in CUSTODY_KEYS}
        if custody["controls"]["relayBefore"]:
            custody["controls"]["relayAfter"] = base.relay_reachable()
        if proc is not None:
            try:
                proc.stdin.close()
                result["appServer"]["stdinClosed"] = True
                proc.wait(timeout=max(0.0, min(35.0, deadline + 35.0 - time.monotonic())))
            except Exception:
                pass  # Unknown settlement remains owned by the enclosing supervisor.
            result["appServer"].update(reaped=proc.poll() is not None, exitCode=proc.poll())
        if stderr is not None: result["appServer"].update(stderr.metadata())
    app = result["appServer"]
    if app["launched"] and (not app["reaped"] or not app["stdinClosed"] or not app["stderrComplete"]):
        result.update(outcome="unknown", code="SHUTDOWN_UNKNOWN", stage="shutdown")
    elif result["outcome"] == "observed" and (app["exitCode"] != 0 or app["stderrBytes"] > base.STDERR_CAP):
        result.update(outcome="unknown", code="TRANSPORT_UNKNOWN", stage="shutdown")
    elif result["outcome"] == "observed" and not custody_ready(result["custody"], after=True):
        result.update(outcome="refused", code="CUSTODY_REFUSED")
    return normalize_result(result, base_source)


def main(base_source):
    sys.stdout.write(json.dumps(run(base_source), sort_keys=True, separators=(",", ":")) + "\n")
    return 0
