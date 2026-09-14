#!/usr/bin/python3.12
"""Bounded custody checks and catalog metadata; no login, thread or model turn."""
from __future__ import annotations

import hashlib
import json
import os
import queue
import socket
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

SCHEMA = "decadans.rm0032.managed-custody-client.v1"
ROOT = "/run/decadans-managed-custody-20260910-v2"
ALLOWED = ROOT + "/allowed"
AUTH_HOME = "/var/lib/decadans-neurobro-codex-auth-v1"
AUTH_FILE = AUTH_HOME + "/auth.json"
PACKAGE = "/opt/decadans-neurobro-codex-v0.153.4"
CODEX = PACKAGE + "/vendor/x86_64-unknown-linux-musl/bin/codex"
CODEX_BYTES = 258659424
CODEX_SHA256 = "56EF98AB4032D317AB26E9B5E5A175650717351EDB16ED9CDE0CB6D1734D62DA"
PYTHON = "/usr/bin/python3.12"
PROFILE = "decadans-managed-custody-v1"
CLIENT = "decadans-managed-custody"
PROXY = "http://127.0.0.2:18443"
PUBLIC = b"decadans-public-custody-control-v1\n"
LINE_CAP = 262144
TOTAL_CAP = 2097152
FRAME_CAP = 256
OUTPUT_CAP = 1024
STDERR_CAP = 65536
WORK_SECONDS = 125.0
METHODS = frozenset(("initialize", "permissionProfile/list", "command/exec", "account/read", "model/list"))
PROBES = ("public", "auth_direct", "auth_self_root", "auth_server_root", "auth_controller_root", "auth_init_root", "fd", "env", "network")
STAGES = frozenset(("preflight", "launch", "initialize", "profile", "probes", "account", "models", "shutdown", "complete"))
CODES = frozenset(("NOT_RUN", "OK", "PREFLIGHT_REFUSED", "LAUNCH_REFUSED", "RPC_REFUSED", "PROTOCOL_REFUSED", "TRANSPORT_UNKNOWN", "PROBE_REFUSED", "CONTROL_REFUSED", "ACCOUNT_REFUSED", "MODEL_UNAVAILABLE", "SHUTDOWN_UNKNOWN", "INTERNAL_UNKNOWN"))

# The only read() in this program fragment is the fixed public control.
# Credential paths are opened and immediately closed; their contents are never read.
PROBE_SCRIPT = r'''import errno,os,socket,stat,sys
mode=sys.argv[1]
if mode=="public":
 try:
  with open(sys.argv[2],"rb") as f: data=f.read(128)
  raise SystemExit(0 if data==b"decadans-public-custody-control-v1\n" else 70)
 except SystemExit: raise
 except OSError: raise SystemExit(71)
if mode=="open":
 try:
  fd=os.open(sys.argv[2],os.O_RDONLY|os.O_CLOEXEC);os.close(fd)
  raise SystemExit(23)
 except SystemExit: raise
 except OSError as e: raise SystemExit({errno.EACCES:20,errno.EPERM:21,errno.ENOENT:22}.get(e.errno,29))
if mode=="fd":
 try: names=os.listdir("/proc/self/fd")
 except OSError: raise SystemExit(49)
 for name in names:
  if not name.isdigit(): continue
  try: s=os.stat("/proc/self/fd/"+name)
  except FileNotFoundError: continue
  except OSError: raise SystemExit(49)
  if stat.S_ISREG(s.st_mode): raise SystemExit(41)
 raise SystemExit(40)
if mode=="env":
 names=("OPENAI_API_KEY","CODEX_API_KEY","OPENAI_ACCESS_TOKEN","CHATGPT_ACCESS_TOKEN","HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","https_proxy","http_proxy","all_proxy")
 raise SystemExit(31 if any(k in os.environ for k in names) else 30)
if mode=="network":
 try:
  with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as s:
   s.settimeout(.75);s.connect(("127.0.0.2",18443))
  raise SystemExit(64)
 except SystemExit: raise
 except OSError as e: raise SystemExit({errno.EACCES:60,errno.EPERM:61,errno.ENETUNREACH:62,errno.ECONNREFUSED:63}.get(e.errno,69))
raise SystemExit(99)
'''


class Stop(Exception):
    def __init__(self, code, unknown=False):
        self.code = code if code in CODES else "INTERNAL_UNKNOWN"
        self.unknown = unknown


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def base_result():
    return {
        "schema": SCHEMA, "outcome": "unknown", "stage": "preflight", "code": "NOT_RUN",
        "initialize": False, "profile": False,
        "controls": {"authMetadata": False, "authOpenClosed": False, "parentFdClosed": False,
                     "proxyEnvPresent": False, "relayBefore": False, "relayAfter": False},
        "probes": [{"name": n, "attempted": False, "exitCode": None, "rpcCode": None,
                    "stdoutBytes": 0, "stderrBytes": 0, "verdict": "not_attempted"} for n in PROBES],
        "account": {"checked": False, "chatgpt": False},
        "model": {"checked": False, "astraListedOnce": False, "mediumSupported": False, "pages": 0},
        "appServer": {"launched": False, "stdinClosed": False, "reaped": False, "exitCode": None,
                      "stderrBytes": 0, "stderrSha256": hashlib.sha256(b"").hexdigest().upper(), "stderrComplete": False},
        "effects": {"credentialContentReadByController": False, "login": False, "thread": False, "modelTurn": False, "telegram": False},
    }


def normalize_result(value):
    """Reject arbitrary output fields, text, incorrect joins and forged passes."""
    template = base_result()
    if not isinstance(value, dict) or set(value) != set(template) or value["schema"] != SCHEMA:
        raise ValueError("invalid-result")
    if value["outcome"] not in {"unknown", "refused", "observed"} or value["stage"] not in STAGES or value["code"] not in CODES:
        raise ValueError("invalid-disposition")
    for k in ("initialize", "profile"):
        if type(value[k]) is not bool: raise ValueError("invalid-boolean")
    for group in ("controls", "account", "effects"):
        if not isinstance(value[group], dict) or set(value[group]) != set(template[group]) or any(type(x) is not bool for x in value[group].values()):
            raise ValueError("invalid-group")
    if any(value["effects"].values()): raise ValueError("forbidden-effect")
    model = value["model"]
    if not isinstance(model, dict) or set(model) != set(template["model"]) or not integer(model["pages"]) or not 0 <= model["pages"] <= 8 or any(type(model[k]) is not bool for k in ("checked", "astraListedOnce", "mediumSupported")):
        raise ValueError("invalid-model-metadata")
    if not model["checked"] and (model["astraListedOnce"] or model["mediumSupported"]): raise ValueError("unchecked-model")
    if value["account"]["chatgpt"] and not value["account"]["checked"]: raise ValueError("unchecked-account")
    app = value["appServer"]
    if not isinstance(app, dict) or set(app) != set(template["appServer"]): raise ValueError("invalid-app-server")
    if any(type(app[k]) is not bool for k in ("launched", "stdinClosed", "reaped", "stderrComplete")) or (app["exitCode"] is not None and not integer(app["exitCode"])):
        raise ValueError("invalid-process")
    if not integer(app["stderrBytes"]) or not 0 <= app["stderrBytes"] <= STDERR_CAP + 1 or not isinstance(app["stderrSha256"], str) or len(app["stderrSha256"]) != 64 or any(c not in "0123456789ABCDEF" for c in app["stderrSha256"]):
        raise ValueError("invalid-stderr-metadata")
    if not isinstance(value["probes"], list) or len(value["probes"]) != len(PROBES): raise ValueError("invalid-probes")
    for name, p in zip(PROBES, value["probes"]):
        if not isinstance(p, dict) or set(p) != set(template["probes"][0]) or p["name"] != name or type(p["attempted"]) is not bool:
            raise ValueError("invalid-probe")
        if any(p[k] is not None and not integer(p[k]) for k in ("exitCode", "rpcCode")) or any(not integer(p[k]) or not 0 <= p[k] <= OUTPUT_CAP + 1 for k in ("stdoutBytes", "stderrBytes")):
            raise ValueError("invalid-probe-count")
        if p["verdict"] not in {"not_attempted", "pass", "refused", "rpc_refused", "unknown"}: raise ValueError("invalid-probe-verdict")
        if not p["attempted"]:
            if p != next(q for q in template["probes"] if q["name"] == name): raise ValueError("invalid-unattempted")
        elif p["verdict"] == "pass":
            if p["exitCode"] not in pass_codes(name) or p["rpcCode"] is not None or p["stdoutBytes"] or p["stderrBytes"]:
                raise ValueError("invalid-probe-pass")
        elif p["verdict"] == "rpc_refused":
            if not integer(p["rpcCode"]) or p["exitCode"] is not None or p["stdoutBytes"] or p["stderrBytes"]: raise ValueError("invalid-rpc-refusal")
    if value["outcome"] == "observed":
        if value["code"] != "OK" or value["stage"] != "complete" or not value["initialize"] or not value["profile"] or not all(value["controls"].values()) or any(p["verdict"] != "pass" for p in value["probes"]) or not all(value["account"].values()) or not all(model[k] for k in ("checked", "astraListedOnce", "mediumSupported")) or not all(app[k] for k in ("launched", "stdinClosed", "reaped", "stderrComplete")) or app["exitCode"] != 0 or app["stderrBytes"] > STDERR_CAP:
            raise ValueError("invalid-observed")
    return json.loads(json.dumps(value, sort_keys=True))


def pass_codes(name):
    if name == "public": return {0}
    if name.startswith("auth_"): return {20, 21, 22}
    return {"fd": {40}, "env": {30}, "network": {60, 61}}[name]


def app_server_argv():
    return [CODEX,
            "-c", "forced_login_method='chatgpt'",
            "-c", "cli_auth_credentials_store='file'",
            "-c", "respect_system_proxy=true",
            "-c", f"default_permissions='{PROFILE}'",
            "-c", f"permissions.{PROFILE}.workspace_roots={{ '{ALLOWED}'=true }}",
            "-c", f"permissions.{PROFILE}.filesystem={{ ':root'='deny', ':minimal'='read', ':workspace_roots'='read', '{PACKAGE}'='read', '{AUTH_HOME}'='deny' }}",
            "-c", f"permissions.{PROFILE}.network={{ enabled=false }}",
            "-c", "shell_environment_policy.inherit='none'", "app-server"]


def app_server_env():
    return {"HOME": AUTH_HOME, "CODEX_HOME": AUTH_HOME, "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin", "RUST_LOG": "off", "HTTPS_PROXY": PROXY, "HTTP_PROXY": PROXY}


def probe_argv(name, server_pid, controller_pid):
    prefix = [PYTHON, "-I", "-S", "-B", "-c", PROBE_SCRIPT]
    if name == "public": return prefix + ["public", ALLOWED + "/public.txt"]
    paths = {"auth_direct": AUTH_FILE, "auth_self_root": "/proc/self/root" + AUTH_FILE,
             "auth_server_root": f"/proc/{server_pid}/root" + AUTH_FILE,
             "auth_controller_root": f"/proc/{controller_pid}/root" + AUTH_FILE,
             "auth_init_root": "/proc/1/root" + AUTH_FILE}
    if name in paths: return prefix + ["open", paths[name]]
    if name == "fd": return prefix + ["fd"]
    if name in ("env", "network"): return prefix + [name]
    raise ValueError("invalid-probe-name")


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError("duplicate-json-key")
        result[key] = value
    return result


class Rpc:
    def __init__(self, proc, deadline):
        self.proc, self.deadline, self.next_id = proc, deadline, 1
        self.items = queue.Queue(maxsize=FRAME_CAP + 1)
        self.failed = threading.Event()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        count = total = 0
        try:
            while True:
                line = self.proc.stdout.readline(LINE_CAP + 1)
                if not line:
                    self.items.put_nowait(None)
                    return
                count += 1
                total += len(line)
                if len(line) > LINE_CAP or not line.endswith(b"\n") or total > TOTAL_CAP or count > FRAME_CAP:
                    raise ValueError("bounded-output")
                self.items.put_nowait(line)
        except Exception:
            self.failed.set()

    def _write(self, frame):
        if time.monotonic() >= self.deadline or self.failed.is_set(): raise Stop("TRANSPORT_UNKNOWN", True)
        try:
            self.proc.stdin.write(json.dumps(frame, separators=(",", ":")).encode("utf-8") + b"\n")
            self.proc.stdin.flush()
        except Exception:
            raise Stop("TRANSPORT_UNKNOWN", True) from None

    def initialized(self):
        self._write({"method": "initialized"})

    def exchange(self, method, params, seconds=10.0):
        if method not in METHODS: raise Stop("PROTOCOL_REFUSED")
        request_id = self.next_id
        self.next_id += 1
        self._write({"id": request_id, "method": method, "params": params})
        deadline = min(self.deadline, time.monotonic() + seconds)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.failed.is_set(): raise Stop("TRANSPORT_UNKNOWN", True)
            try: line = self.items.get(timeout=remaining)
            except queue.Empty: raise Stop("TRANSPORT_UNKNOWN", True) from None
            if line is None: raise Stop("TRANSPORT_UNKNOWN", True)
            try: frame = json.loads(line.decode("utf-8"), object_pairs_hook=_unique_pairs)
            except Exception: raise Stop("PROTOCOL_REFUSED") from None
            if not isinstance(frame, dict): raise Stop("PROTOCOL_REFUSED")
            if "id" not in frame and isinstance(frame.get("method"), str):
                # Notifications are discarded in memory without logging.
                continue
            if not integer(frame.get("id")) or frame["id"] != request_id or "method" in frame:
                raise Stop("PROTOCOL_REFUSED")
            if "error" in frame and "result" not in frame and isinstance(frame["error"], dict) and integer(frame["error"].get("code")):
                return None, frame["error"]["code"]
            if "error" not in frame and isinstance(frame.get("result"), dict):
                return frame["result"], None
            raise Stop("PROTOCOL_REFUSED")


class StderrDigest:
    def __init__(self, stream):
        self.stream, self.count = stream, 0
        self.digest = hashlib.sha256()
        self.failed = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            while True:
                data = self.stream.read(4096)
                if not data: return
                self.count += len(data)
                self.digest.update(data)
        except Exception:
            self.failed = True

    def metadata(self):
        self.thread.join(.5)
        return {"stderrBytes": min(STDERR_CAP + 1, self.count),
                "stderrSha256": self.digest.hexdigest().upper(),
                "stderrComplete": not self.failed and not self.thread.is_alive()}


def payload(rpc, method, params, seconds=10.0):
    result, error = rpc.exchange(method, params, seconds)
    if error is not None: raise Stop("RPC_REFUSED")
    return result


def protocol(rpc, result, server_pid):
    result["stage"] = "initialize"
    init = payload(rpc, "initialize", {"clientInfo": {"name": CLIENT, "version": "0.153.4"}, "capabilities": {"experimentalApi": True}})
    result["initialize"] = (init.get("platformOs") == "linux" and init.get("platformFamily") == "unix" and init.get("codexHome") == AUTH_HOME and isinstance(init.get("userAgent"), str) and init["userAgent"].startswith(CLIENT + "/0.153.4 ("))
    if not result["initialize"]: raise Stop("PROTOCOL_REFUSED")
    rpc.initialized()
    result["stage"] = "profile"
    profiles = payload(rpc, "permissionProfile/list", {"cwd": ALLOWED, "limit": 100})
    rows = profiles.get("data")
    if not isinstance(rows, list) or len(rows) > 100 or profiles.get("nextCursor") is not None: raise Stop("PROTOCOL_REFUSED")
    matches = [p for p in rows if isinstance(p, dict) and p.get("id") == PROFILE]
    result["profile"] = len(matches) == 1 and matches[0].get("allowed") is True
    if not result["profile"]: raise Stop("PROTOCOL_REFUSED")
    result["stage"] = "probes"
    for record in result["probes"]:
        record["attempted"] = True
        record["verdict"] = "unknown"
        data, error = rpc.exchange("command/exec", {"command": probe_argv(record["name"], server_pid, os.getpid()), "cwd": ALLOWED, "permissionProfile": PROFILE, "timeoutMs": 3000, "outputBytesCap": OUTPUT_CAP})
        if error is not None:
            record.update(rpcCode=error, verdict="rpc_refused")
            continue
        exit_code, out, err = data.get("exitCode"), data.get("stdout"), data.get("stderr")
        if not integer(exit_code) or not isinstance(out, str) or not isinstance(err, str): raise Stop("PROTOCOL_REFUSED")
        try: out_len, err_len = len(out.encode("utf-8")), len(err.encode("utf-8"))
        except UnicodeError: raise Stop("PROTOCOL_REFUSED") from None
        record.update(exitCode=exit_code, stdoutBytes=min(OUTPUT_CAP + 1, out_len), stderrBytes=min(OUTPUT_CAP + 1, err_len), verdict="pass" if exit_code in pass_codes(record["name"]) and out_len == err_len == 0 else "refused")
    if any(p["verdict"] != "pass" for p in result["probes"]): raise Stop("PROBE_REFUSED")
    result["stage"] = "account"
    account = payload(rpc, "account/read", {"refreshToken": False})
    result["account"]["checked"] = True
    result["account"]["chatgpt"] = isinstance(account.get("account"), dict) and account["account"].get("type") == "chatgpt" and type(account.get("requiresOpenaiAuth")) is bool
    if not result["account"]["chatgpt"]: raise Stop("ACCOUNT_REFUSED")
    result["stage"] = "models"
    cursor, seen, matches, medium = None, set(), 0, False
    for page in range(1, 9):
        catalog = payload(rpc, "model/list", {"cursor": cursor, "limit": 100, "includeHidden": False}, 20.0)
        rows = catalog.get("data")
        if not isinstance(rows, list) or len(rows) > 100: raise Stop("PROTOCOL_REFUSED")
        for item in rows:
            if not isinstance(item, dict): raise Stop("PROTOCOL_REFUSED")
            if item.get("model") == "gpt-6-astra" and item.get("hidden") is False:
                matches += 1
                efforts = item.get("supportedReasoningEfforts")
                if not isinstance(efforts, list): raise Stop("PROTOCOL_REFUSED")
                medium = any(isinstance(e, dict) and e.get("reasoningEffort") == "medium" for e in efforts)
        result["model"]["pages"] = page
        cursor = catalog.get("nextCursor")
        if cursor is None: break
        if not isinstance(cursor, str) or not cursor or len(cursor) > 4096 or cursor in seen: raise Stop("PROTOCOL_REFUSED")
        seen.add(cursor)
    else: raise Stop("PROTOCOL_REFUSED")
    result["model"].update(checked=True, astraListedOnce=matches == 1, mediumSupported=medium)
    if matches != 1 or not medium: raise Stop("MODEL_UNAVAILABLE")


def relay_reachable():
    try:
        with socket.create_connection(("127.0.0.2", 18443), timeout=1.0): return True
    except OSError: return False


def check_path(path, directory, uid, mode):
    s = os.lstat(path)
    if os.path.realpath(path) != path or not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)) or s.st_uid != uid or s.st_gid != uid or stat.S_IMODE(s.st_mode) != mode:
        raise Stop("PREFLIGHT_REFUSED")
    return s


def preflight(result):
    if os.getuid() != 20000 or os.getgid() != 20000: raise Stop("PREFLIGHT_REFUSED")
    check_path(ROOT, True, 20000, 0o700)
    check_path(AUTH_HOME, True, 20000, 0o700)
    auth = check_path(AUTH_FILE, False, 20000, 0o600)
    if os.path.lexists(AUTH_HOME + "/config.toml"): raise Stop("PREFLIGHT_REFUSED")
    installed = check_path(CODEX, False, 0, 0o555)
    if installed.st_size != CODEX_BYTES: raise Stop("PREFLIGHT_REFUSED")
    digest = hashlib.sha256()
    with open(CODEX, "rb", buffering=0) as source:
        for block in iter(lambda: source.read(1048576), b""): digest.update(block)
    if digest.hexdigest().upper() != CODEX_SHA256: raise Stop("PREFLIGHT_REFUSED")
    result["controls"]["authMetadata"] = True
    fd = os.open(AUTH_FILE, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (auth.st_dev, auth.st_ino): raise Stop("PREFLIGHT_REFUSED")
    finally: os.close(fd)
    result["controls"].update(authOpenClosed=True, parentFdClosed=True)
    Path(ALLOWED).mkdir(mode=0o700, exist_ok=False)
    with open(ALLOWED + "/public.txt", "xb") as public: public.write(PUBLIC)
    os.chmod(ALLOWED + "/public.txt", 0o400)
    result["controls"]["proxyEnvPresent"] = app_server_env().get("HTTPS_PROXY") == PROXY
    result["controls"]["relayBefore"] = relay_reachable()
    if not result["controls"]["relayBefore"]: raise Stop("CONTROL_REFUSED")


def run():
    result, proc, stderr = base_result(), None, None
    deadline = time.monotonic() + WORK_SECONDS
    try:
        preflight(result)
        result["stage"] = "launch"
        try:
            proc = subprocess.Popen(app_server_argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ALLOWED, env=app_server_env(), close_fds=True, bufsize=0)
        except OSError: raise Stop("LAUNCH_REFUSED") from None
        result["appServer"]["launched"] = True
        stderr = StderrDigest(proc.stderr)
        protocol(Rpc(proc, deadline), result, proc.pid)
        result.update(outcome="observed", code="OK", stage="complete")
    except Stop as exc:
        result.update(outcome="unknown" if exc.unknown else "refused", code=exc.code)
    except Exception:
        result.update(outcome="unknown", code="INTERNAL_UNKNOWN")
    finally:
        if result["controls"]["relayBefore"]:
            result["controls"]["relayAfter"] = relay_reachable()
        if proc is not None:
            try:
                proc.stdin.close()
                result["appServer"]["stdinClosed"] = True
                proc.wait(timeout=max(0.0, min(35.0, deadline + 35.0 - time.monotonic())))
            except Exception:
                pass  # Controller never kills a credential owner; supervisor reconciles the exact unit.
            result["appServer"].update(reaped=proc.poll() is not None, exitCode=proc.poll())
        if stderr is not None: result["appServer"].update(stderr.metadata())
    app = result["appServer"]
    if app["launched"] and (not app["reaped"] or not app["stdinClosed"] or not app["stderrComplete"]):
        result.update(outcome="unknown", code="SHUTDOWN_UNKNOWN", stage="shutdown")
    elif result["outcome"] == "observed" and (app["exitCode"] != 0 or app["stderrBytes"] > STDERR_CAP):
        result.update(outcome="unknown", code="TRANSPORT_UNKNOWN", stage="shutdown")
    elif result["outcome"] == "observed" and not all(result["controls"].values()):
        result.update(outcome="refused", code="CONTROL_REFUSED")
    return normalize_result(result)


def main():
    # No generic command, input prompt or RPC forwarding entry point exists.
    value = run()
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
