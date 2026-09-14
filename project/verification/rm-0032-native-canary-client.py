"""Prepared synthetic native-session canary. No invocation occurs on import.

The root controller owns admission, source embedding, runtime units and cleanup.
run() defaults to real approved custody/launch ports; tests must inject all four
fixture ports. Neither prompts nor instructions contain the answer marker.
"""
import hashlib
import json
import re
import subprocess
import sys
import time
import types

PINS = {
    "custody": "6A5F187C701708830B8556465DDEA0142196250302A1062C6E343C3F7BA598E9",
    "canary": "43E9422897B97CE4DC9AACD40494E94D89FD770AD84B9E6361666A6F70D3D967",
    "engine": "88076A06C9B2525615B45B59C659D9FE34F2D91D79138E5C0DF5FC8193B5A885",
    "rpc": "2A7F04C392B7BC5CB81165C02E27F8D04EF6F400CB464BF3F91C378A8F23D720",
}
SCHEMA = "decadans.rm0032.native-canary.v1"
MARKER = "NEUROBRO_NATIVE_MEMORY_OK."
INSTRUCTIONS = "This is a synthetic connectivity and conversation-memory check. Follow each turn's tool-use requirement exactly. Use only the declared history tool. No files, execution, delegation, web search or user-input requests. Return only the requested marker, preserving its punctuation."
PROMPTS = (
    'Call neurobro_read_history exactly once with {"fromDate":1,"toDate":200,"cursor":null}. Return exactly the marker in that tool response, preserving all punctuation and adding no other characters.',
    "Without calling any tool, return exactly the marker returned in the previous turn, preserving all punctuation and adding no other characters.",
)
TOOL_SPEC = {"type": "function", "name": "neurobro_read_history", "description": "Read the bounded synthetic history fixture for this connectivity check.",
    "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
        "fromDate": {"type": "integer", "minimum": 1, "maximum": 2147483646},
        "toDate": {"type": "integer", "minimum": 1, "maximum": 2147483646}, "cursor": {"type": ["string", "null"]}},
        "required": ["fromDate", "toDate", "cursor"]}}
CODES = {"NOT_RUN", "OK", "SOURCE_REFUSED", "CONFIG_REFUSED", "CUSTODY_REFUSED", "FIRST_TURN_REFUSED", "SECOND_TURN_REFUSED",
    "DEADLINE_UNKNOWN", "LAUNCH_UNKNOWN", "TRANSPORT_UNKNOWN", "SHUTDOWN_UNKNOWN", "CONTROL_REFUSED", "INTERNAL_UNKNOWN"}
STAGES = {"validate", "preflight", "launch", "custody", "first-turn", "second-turn", "shutdown", "complete"}
ENGINE_CODES = {"NOT_RUN", "BUSY", "SESSION_POISONED", "OK", "CONFIG_REFUSED", "INPUT_REFUSED", "SESSION_LIMIT", "PROTOCOL_REFUSED", "TOOL_REFUSED", "ANSWER_REFUSED", "TURN_REFUSED", "BOUNDS_REFUSED", "TRANSPORT_UNKNOWN", "THREAD_REFUSED", "CUSTODY_REFUSED", "TOOL_EVENT_REFUSED"}
ENGINE_SITES = {"none", "observer_or_transport", "frame", "spec", "config", "ports", "source", "input", "session", "arguments", "item", "tool_item", "tool_item_correlation", "tool_item_result", "tool_item_changed", "tool_item_missing", "answer", "answer_changed", "answer_missing", "turn", "item_timestamp", "resolved", "deadline", "request_id", "exchange", "thread_ack", "tool_result", "request", "duplicate_request", "correlation", "duplicate_call", "tool_calls", "tool_wire", "turn_ack", "events"}
CUSTODY_CODES = {"NOT_RUN", "OK", "PREFLIGHT_REFUSED", "LAUNCH_REFUSED", "RPC_REFUSED", "PROTOCOL_REFUSED", "TRANSPORT_UNKNOWN", "PROBE_REFUSED", "CONTROL_REFUSED", "ACCOUNT_REFUSED", "MODEL_UNAVAILABLE", "SHUTDOWN_UNKNOWN", "INTERNAL_UNKNOWN"}
CUSTODY_STAGES = {"preflight", "launch", "initialize", "profile", "probes", "account", "models", "shutdown", "complete"}
RPC_CODES = {"OK", "CONFIG_REFUSED", "PROTOCOL_REFUSED", "PHASE_REFUSED", "BOUNDS_REFUSED", "TRANSPORT_UNKNOWN", "CONCURRENT_REFUSED", "CLOSED", "CLOSE_UNKNOWN", "SHUTDOWN_UNKNOWN"}
RPC_SITES = {"none", "line", "json", "envelope", "marker", "unicode", "payload", "phase", "deadline", "read", "write", "selector", "eof", "response_id"}
RPC_OPERATIONS = {"none", "other", "initialize", "initialized", "permissionProfile/list", "command/exec", "account/read", "model/list", "modelProvider/capabilities/read", "thread/start", "turn/start", "admit_model", "next_frame", "respond"}
RPC_PHASES = {"not_created", "custody", "model", "poisoned", "shutdown"}

ENVELOPE_TYPES = {"not_seen", "absent", "object", "array", "null", "string", "number", "boolean"}
ENVELOPE_METHODS = {"not_seen", "absent", "not_string", "other", "configWarning", "deprecationNotice", "account/updated", "account/rateLimits/updated", "account/chatgptAuthTokens/refresh"}

OBSERVER_SITES = frozenset(('account_shape', 'base_protocol', 'delta_shape', 'delta_utf8', 'error_shape', 'event_params', 'item_conflict', 'item_shape', 'item_text', 'item_utf8', 'model_metadata_shape', 'none', 'notification_expected', 'notification_item', 'notification_shape', 'rpc_after_model', 'rpc_budget', 'rpc_frame', 'rpc_id', 'rpc_json', 'rpc_method', 'rpc_result', 'settings_shape', 'status_shape', 'thread_event', 'thread_id', 'thread_response', 'turn_id', 'turn_response', 'turn_shape', 'warning_shape'))
OBSERVER_METHODS = frozenset(('account/login/completed', 'account/rateLimits/updated', 'account/read', 'account/updated', 'app/list/updated', 'autoApprovalReview/strictReviewRequired', 'command/exec', 'command/exec/outputDelta', 'configWarning', 'deprecationNotice', 'error', 'externalAgentConfig/import/completed', 'externalAgentConfig/import/progress', 'fs/changed', 'fuzzyFileSearch/sessionCompleted', 'fuzzyFileSearch/sessionUpdated', 'guardianWarning', 'hook/completed', 'hook/started', 'initialize', 'item/agentMessage/delta', 'item/autoApprovalReview/completed', 'item/autoApprovalReview/started', 'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction', 'item/completed', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated', 'item/mcpToolCall/progress', 'item/plan/delta', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/started', 'mcpServer/event/stream/notification', 'mcpServer/oauthLogin/completed', 'mcpServer/startupStatus/updated', 'model/list', 'model/rerouted', 'model/safetyBuffering/updated', 'model/verification', 'modelProvider/authRecoveryCompleted', 'modelProvider/authRecoveryStarted', 'none', 'other', 'permissionProfile/list', 'process/exited', 'process/outputDelta', 'project/changed', 'remoteControl/status/changed', 'serverRequest/resolved', 'skills/changed', 'thread/archived', 'thread/closed', 'thread/compacted', 'thread/deleted', 'thread/environment/connected', 'thread/environment/disconnected', 'thread/goal/cleared', 'thread/goal/updated', 'thread/name/updated', 'thread/project/updated', 'thread/queue/changed', 'thread/realtime/closed', 'thread/realtime/error', 'thread/realtime/item/completed', 'thread/realtime/item/started', 'thread/realtime/item/transcript/delta', 'thread/realtime/itemAdded', 'thread/realtime/outputAudio/delta', 'thread/realtime/sdp', 'thread/realtime/started', 'thread/realtime/transcript/delta', 'thread/realtime/transcript/done', 'thread/reverted', 'thread/settings/updated', 'thread/start', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'thread/unarchived', 'turn/completed', 'turn/diff/updated', 'turn/moderationMetadata', 'turn/plan/updated', 'turn/start', 'turn/started', 'warning', 'windows/worldWritableWarning', 'windowsSandbox/setupCompleted'))
OBSERVER_SHAPES = ('paramsObject', 'threadIdPresent', 'threadIdMatched', 'turnIdPresent', 'turnIdMatched', 'nestedThreadObject', 'nestedTurnObject', 'nestedItemObject', 'turnItemsList', 'threadEphemeralPresent', 'threadEphemeralTrue')


REMOTE_STATUSES = frozenset({"not_seen", "invalid", "disabled", "connecting", "connected", "errored"})

def observer_metadata():
    return {"site": "none", "method": "none", "shape": dict.fromkeys(OBSERVER_SHAPES, False), "remoteControlStatus": "not_seen"}

PROBE_PASS_CODES = [{0}] + [{20, 21, 22}] * 5 + [{40}, {30}, {60, 61}]


class Stop(Exception):
    def __init__(self, code, unknown=False): self.code, self.unknown = code, unknown


def result_template():
    return {"schema": SCHEMA, "outcome": "refused", "code": "NOT_RUN", "stage": "validate", "injectedPorts": False,
        "diagnostics": {"originalCode": "NOT_RUN", "originalStage": "validate", "custodyCode": "NOT_RUN", "custodyStage": "preflight",
            "rpcCode": "OK", "rpcSite": "none", "rpcOperation": "none", "rpcPhase": "not_created", "framesRead": 0, "framesWritten": 0,
            "bytesRead": 0, "bytesWritten": 0, "cleanupUnknown": False,
            "rpcEnvelopeType": "not_seen", "rpcEnvelopeKeys": 0, "rpcEnvelopeUnknownKeys": 0, "rpcEnvelopeMethod": "not_seen",
            "rpcEnvelopeIdType": "not_seen", "rpcEnvelopeParamsType": "not_seen"},
        "custody": {"initialize": False, "profile": False, "controlsPassed": False, "relayAfter": False,
            "probePass": [False] * 9, "probeExitCodes": [None] * 9, "accountChatgpt": False, "astraMedium": False},
        "native": {"admitted": False, "threadStartDispatches": 0, "threadAcknowledged": False, "turnStartDispatches": 0,
            "turns": [{"attempted": False, "completed": False, "answerExact": False, "answerBytes": 0, "toolCallbacks": 0, "toolCalls": 0, "toolRefusals": 0, "events": 0,
                "code": "NOT_RUN", "failureSite": "none", "sessionPoisoned": False, "observer": observer_metadata()} for _ in range(2)]},
        "appServer": {"launched": False, "stdinClosed": False, "stdoutEof": False, "reaped": False, "exitCode": None,
            "stderrBytes": 0, "stderrComplete": False, "transportUnknown": False},
        "limits": {"workSeconds": 125, "cleanupSeconds": 35, "threadLimit": 1, "turnLimit": 2, "toolCallbackLimit": 1,
            "transportRetriesDisabled": False, "syntheticOnly": True, "telegram": False}}


def normalize_result(value):
    template = result_template()
    def check(actual, expected):
        if type(expected) is dict:
            if type(actual) is not dict or set(actual) != set(expected): raise ValueError("native-canary-result-refused")
            for key in expected: check(actual[key], expected[key])
        elif type(expected) is list:
            if type(actual) is not list or len(actual) != len(expected): raise ValueError("native-canary-result-refused")
            for a, b in zip(actual, expected): check(a, b)
        elif type(expected) is bool:
            if type(actual) is not bool: raise ValueError("native-canary-result-refused")
        elif type(expected) is int:
            if type(actual) is not int or not 0 <= actual <= 1048576: raise ValueError("native-canary-result-refused")
        elif expected is None:
            if actual is not None and (type(actual) is not int or not -255 <= actual <= 255): raise ValueError("native-canary-result-refused")
        elif type(actual) is not str: raise ValueError("native-canary-result-refused")
    check(value, template)
    if value["schema"] != SCHEMA or value["code"] not in CODES or value["stage"] not in STAGES or value["outcome"] not in {"refused", "unknown", "observed"} or value["limits"] != template["limits"]:
        raise ValueError("native-canary-result-refused")
    d = value["diagnostics"]
    for key, allowed in (("originalCode", CODES), ("originalStage", STAGES), ("custodyCode", CUSTODY_CODES), ("custodyStage", CUSTODY_STAGES),
                         ("rpcCode", RPC_CODES), ("rpcSite", RPC_SITES), ("rpcOperation", RPC_OPERATIONS), ("rpcPhase", RPC_PHASES)):
        if d[key] not in allowed: raise ValueError("native-canary-result-refused")
    for key in ("rpcEnvelopeType", "rpcEnvelopeIdType", "rpcEnvelopeParamsType"):
        if d[key] not in ENVELOPE_TYPES: raise ValueError("native-canary-result-refused")
    if d["rpcEnvelopeMethod"] not in ENVELOPE_METHODS or d["rpcEnvelopeKeys"] >= 2**19 or d["rpcEnvelopeUnknownKeys"] > 32: raise ValueError("native-canary-result-refused")
    if value["outcome"] == "observed" and (d["originalCode"] != "OK" or d["originalStage"] != "complete" or d["cleanupUnknown"] or d["rpcCode"] != "OK"): raise ValueError("native-canary-result-refused")
    n, c, a = value["native"], value["custody"], value["appServer"]
    if n["threadStartDispatches"] > 1 or n["turnStartDispatches"] > 2: raise ValueError("native-canary-result-refused")
    for turn in n["turns"]:
        if turn["observer"]["remoteControlStatus"] not in REMOTE_STATUSES: raise ValueError("native-canary-result-refused")
        if value["outcome"] == "observed" and turn["observer"]["remoteControlStatus"] not in {"not_seen", "disabled"}: raise ValueError("native-canary-result-refused")
        if turn["observer"]["site"] not in OBSERVER_SITES or turn["observer"]["method"] not in OBSERVER_METHODS: raise ValueError("native-canary-result-refused")
        if turn["code"] not in ENGINE_CODES or turn["failureSite"] not in ENGINE_SITES: raise ValueError("native-canary-result-refused")
        if turn["answerExact"] and turn["answerBytes"] != len(MARKER.encode()): raise ValueError("native-canary-result-refused")
        if turn["completed"] and not turn["attempted"]: raise ValueError("native-canary-result-refused")
    if value["outcome"] == "observed":
        if any(code not in allowed for code, allowed in zip(c["probeExitCodes"], PROBE_PASS_CODES)): raise ValueError("native-canary-result-refused")
        if value["code"] != "OK" or value["stage"] != "complete" or not all(c[k] for k in ("initialize", "profile", "controlsPassed", "relayAfter", "accountChatgpt", "astraMedium")) or not all(c["probePass"]): raise ValueError("native-canary-result-refused")
        if not n["admitted"] or not n["threadAcknowledged"] or n["threadStartDispatches"] != 1 or n["turnStartDispatches"] != 2: raise ValueError("native-canary-result-refused")
        for index, turn in enumerate(n["turns"]):
            if not all(turn[k] for k in ("attempted", "completed", "answerExact")) or turn["toolCallbacks"] != (1 if index == 0 else 0) or turn["toolCalls"] != turn["toolCallbacks"] or turn["toolRefusals"] or turn["sessionPoisoned"] or turn["code"] != "OK": raise ValueError("native-canary-result-refused")
        if not all(a[k] for k in ("launched", "stdinClosed", "stdoutEof", "reaped", "stderrComplete")) or a["exitCode"] != 0 or a["stderrBytes"] > 65536 or a["transportUnknown"]: raise ValueError("native-canary-result-refused")
    return json.loads(json.dumps(value, sort_keys=True))


def load_sources(sources, config):
    if type(sources) is not dict or set(sources) != set(PINS): raise Stop("SOURCE_REFUSED")
    # Verify every source before executing any of them or invoking a test port.
    for name, expected in PINS.items():
        source = sources[name]
        if type(source) is not str or len(source.encode()) > 262144 or hashlib.sha256(source.encode()).hexdigest().upper() != expected: raise Stop("SOURCE_REFUSED")
    if type(config) is not dict or set(config) != {"root", "cwd", "profile"} or any(type(config[k]) is not str for k in config): raise Stop("CONFIG_REFUSED")
    if not re.fullmatch(r"/run/decadans-[A-Za-z0-9_-]+", config["root"]) or config["cwd"] != config["root"] + "/workspace" or not re.fullmatch(r"decadans-[a-z0-9][a-z0-9-]{0,110}", config["profile"]): raise Stop("CONFIG_REFUSED")
    modules = {}
    for name in ("canary", "engine", "rpc"):
        module = types.ModuleType("reviewed_native_canary_" + name)
        exec(compile(sources[name], "<reviewed-native-canary-" + name + ">", "exec"), module.__dict__)
        modules[name] = module
    canary = modules["canary"]
    canary.ROOT, canary.ALLOWED, canary.PROFILE = config["root"], config["cwd"], config["profile"]
    modules["custody"] = canary.load_base(sources["custody"])
    return modules


class DeadlineRpc:
    """One aggregate work deadline; no new allowance at a later model turn."""
    def __init__(self, rpc, deadline, clock, counters): self.rpc, self.deadline, self.clock, self.counters = rpc, deadline, clock, counters
    def remaining(self, seconds=125):
        left = self.deadline - self.clock()
        if left <= 0: raise Stop("DEADLINE_UNKNOWN", True)
        return min(seconds, left)
    def exchange(self, method, params, seconds=10):
        limit = self.remaining(seconds)
        if method in {"thread/start", "turn/start"}:
            key, maximum = ("threadStartDispatches", 1) if method == "thread/start" else ("turnStartDispatches", 2)
            if self.counters[key] >= maximum: raise Stop("TRANSPORT_UNKNOWN", True)
            self.counters[key] += 1
        result = self.rpc.exchange(method, params, limit); self.remaining(); return result
    def initialized(self):
        # NativeRpc successor must accept this optional deadline argument; the
        # historical zero-argument API otherwise hides an unconditional10s write.
        self.rpc.initialized(self.remaining(10)); self.remaining()
    def next_frame(self, seconds):
        result = self.rpc.next_frame(self.remaining(seconds)); self.remaining(); return result
    def respond(self, request_id, result, seconds):
        self.rpc.respond(request_id, result, self.remaining(seconds)); self.remaining()


def run(sources, config, ports=None):
    result, proc, rpc, stderr, base, custody = result_template(), None, None, None, None, None
    clock = time.monotonic
    deadline = None
    try:
        modules = load_sources(sources, config)
        base, canary = modules["custody"], modules["canary"]
        if ports is not None and (type(ports) is not dict or set(ports) != {"clock", "popen", "preflight", "relay_reachable"} or not all(callable(v) for v in ports.values())): raise Stop("CONFIG_REFUSED")
        result["injectedPorts"] = ports is not None
        ports = ports or {"clock": time.monotonic, "popen": subprocess.Popen, "preflight": lambda b, value: b.preflight(value), "relay_reachable": base.relay_reachable}
        clock = ports["clock"]; deadline = clock() + 125
        custody = base.base_result(); result["stage"] = "preflight"
        ports["preflight"](base, custody)
        if clock() >= deadline: raise Stop("DEADLINE_UNKNOWN", True)
        result["stage"] = "launch"
        try:
            proc = ports["popen"](canary.launch_argv(base), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=config["cwd"], env=base.app_server_env(), close_fds=True, bufsize=0)
        except Exception: raise Stop("LAUNCH_UNKNOWN", True) from None
        result["appServer"]["launched"] = True
        stderr = base.StderrDigest(proc.stderr)
        rpc = modules["rpc"].NativeRpc(proc)
        bounded = DeadlineRpc(rpc, deadline, clock, result["native"])
        result["stage"] = "custody"; base.protocol(bounded, custody, proc.pid)
        result["diagnostics"]["custodyCode"] = "OK"
        if not canary.custody_ready(custody): raise Stop("CUSTODY_REFUSED")
        bounded.remaining(); rpc.admit_model(); result["native"]["admitted"] = True
        active_turn = 0
        def tool(params, seconds):
            bounded.remaining(seconds)
            turn = result["native"]["turns"][active_turn]; turn["toolCallbacks"] += 1
            if active_turn != 0 or turn["toolCallbacks"] != 1 or params.get("tool") != TOOL_SPEC["name"] or params.get("arguments") != {"fromDate": 1, "toDate": 200, "cursor": None}: raise Stop("FIRST_TURN_REFUSED")
            return {"success": True, "contentItems": [{"type": "inputText", "text": json.dumps({"schema": "synthetic-history-fixture-v1", "marker": MARKER}, separators=(",", ":"))}]}
        engine = modules["engine"].NativeConversation(sources["canary"], profile=config["profile"], cwd=config["cwd"],
            tool_spec=TOOL_SPEC, instructions=INSTRUCTIONS, rpc=bounded, tool=tool, clock=clock)
        for index, prompt in enumerate(PROMPTS):
            active_turn = index; result["stage"] = "first-turn" if index == 0 else "second-turn"
            bounded.remaining(); turn = result["native"]["turns"][index]; turn["attempted"] = True
            value = engine.run(prompt)
            metadata, answer = value["metadata"], value["answer"]
            turn["completed"] = metadata.get("turnCompleted") is True
            turn["answerExact"] = type(answer) is str and answer == MARKER
            turn["answerBytes"] = min(4097, len(answer.encode())) if type(answer) is str else 0
            turn["toolCalls"] = metadata.get("toolCalls", 0); turn["events"] = metadata.get("eventCount", 0); turn["toolRefusals"] = metadata.get("toolRefusals", 0)
            turn["code"] = metadata.get("code", "TRANSPORT_UNKNOWN"); turn["failureSite"] = metadata.get("failureSite", "observer_or_transport")
            turn["sessionPoisoned"] = metadata.get("sessionPoisoned") is True
            turn["observer"] = metadata["observer"]
            result["native"]["threadAcknowledged"] = engine.state()["threadStarted"]
            del value, answer
            bounded.remaining()
            if metadata.get("code") != "OK" or not turn["completed"] or not turn["answerExact"] or turn["toolCallbacks"] != (1 if index == 0 else 0) or turn["toolCalls"] != turn["toolCallbacks"] or turn["toolRefusals"]:
                raise Stop("FIRST_TURN_REFUSED" if index == 0 else "SECOND_TURN_REFUSED", metadata.get("outcome") == "unknown" or turn["sessionPoisoned"])
        result.update(outcome="observed", code="OK", stage="complete")
    except Stop as error: result.update(outcome="unknown" if error.unknown else "refused", code=error.code)
    except Exception as error:
        if base is not None and isinstance(error, base.Stop):
            result["diagnostics"]["custodyCode"] = error.code if type(error.code) is str and error.code in CUSTODY_CODES else "INTERNAL_UNKNOWN"
            result.update(outcome="unknown" if error.unknown else "refused", code="TRANSPORT_UNKNOWN" if error.unknown else "CUSTODY_REFUSED")
        elif "modules" in locals() and isinstance(error, modules["rpc"].NativeRpcError):
            if rpc is None:
                result["diagnostics"].update(rpcCode=error.code if error.code in RPC_CODES else "CONFIG_REFUSED",
                    rpcSite=error.site if error.site in RPC_SITES else "none", rpcPhase="not_created")
            result.update(outcome="unknown" if error.unknown else "refused",
                code="CONFIG_REFUSED" if rpc is None else "TRANSPORT_UNKNOWN" if error.unknown else "CUSTODY_REFUSED")
        else: result.update(outcome="unknown", code="INTERNAL_UNKNOWN")
    finally:
        diagnostic = result["diagnostics"]
        diagnostic.update(originalCode=result["code"], originalStage=result["stage"])
        if custody is not None: diagnostic["custodyStage"] = custody["stage"]
        if rpc is not None:
            before = rpc.metadata(); failure = before["firstFailure"]
            shape = before["failureEnvelope"]
            for key, source in (("rpcEnvelopeType", "type"), ("rpcEnvelopeKeys", "keys"), ("rpcEnvelopeUnknownKeys", "unknownKeys"),
                                ("rpcEnvelopeMethod", "method"), ("rpcEnvelopeIdType", "idType"), ("rpcEnvelopeParamsType", "paramsType")):
                diagnostic[key] = shape[source]
            diagnostic.update(rpcCode=failure["code"], rpcSite=failure["site"], rpcOperation=failure["operation"],
                              rpcPhase=failure["phase"] if failure["code"] != "OK" else before["phase"])
            for key in ("framesRead", "framesWritten", "bytesRead", "bytesWritten"): diagnostic[key] = min(1048576, before[key])
        cleanup_deadline = min(clock() + 35, deadline + 35) if proc is not None else None
        if base is not None and custody is not None:
            if custody["controls"]["relayBefore"]:
                try: custody["controls"]["relayAfter"] = ports["relay_reachable"]() is True
                except Exception: custody["controls"]["relayAfter"] = False
            result["custody"] = {"initialize": custody["initialize"], "profile": custody["profile"],
                "controlsPassed": all(v for k, v in custody["controls"].items() if k != "relayAfter"), "relayAfter": custody["controls"]["relayAfter"],
                "probePass": [p["verdict"] == "pass" for p in custody["probes"]], "probeExitCodes": [p["exitCode"] for p in custody["probes"]],
                "accountChatgpt": all(custody["account"].values()), "astraMedium": all(custody["model"][k] for k in ("checked", "astraListedOnce", "mediumSupported"))}
        if proc is not None:
            left = lambda: max(0.0, cleanup_deadline - clock())
            if rpc is not None:
                try:
                    rpc.close_input(); result["appServer"]["stdinClosed"] = rpc.metadata()["inputClosed"]
                    if left() > 0: result["appServer"]["stdoutEof"] = rpc.drain_to_eof(left()) is True
                    result["appServer"]["transportUnknown"] = rpc.metadata()["unknown"]
                except Exception:
                    result["appServer"]["transportUnknown"] = True
                    diagnostic["cleanupUnknown"] = True
            try:
                if left() > 0: proc.wait(timeout=left())
            except Exception: pass
            try:
                code = proc.poll(); result["appServer"].update(reaped=code is not None, exitCode=code)
            except Exception: pass
            if stderr is not None:
                stderr.thread.join(min(.5, left()))
                result["appServer"].update(stderrBytes=min(base.STDERR_CAP + 1, stderr.count), stderrComplete=not stderr.failed and not stderr.thread.is_alive())
            if rpc is not None:
                try: rpc.close()
                except Exception: diagnostic["cleanupUnknown"] = True
                if rpc.metadata()["code"] in {"CLOSE_UNKNOWN", "SHUTDOWN_UNKNOWN"}: diagnostic["cleanupUnknown"] = True
                result["appServer"]["transportUnknown"] = result["appServer"]["transportUnknown"] or rpc.metadata()["unknown"]
    app = result["appServer"]
    if app["launched"] and (not all(app[k] for k in ("stdinClosed", "stdoutEof", "reaped", "stderrComplete")) or app["exitCode"] != 0 or app["stderrBytes"] > 65536 or diagnostic["cleanupUnknown"]):
        diagnostic["cleanupUnknown"] = True
        result.update(outcome="unknown", code="SHUTDOWN_UNKNOWN", stage="shutdown")
    elif result["outcome"] == "observed" and not result["custody"]["relayAfter"]:
        result.update(outcome="refused", code="CONTROL_REFUSED")
    return normalize_result(result)


def main(sources, config):
    value = run(sources, config)
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    return 0
