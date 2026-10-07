"""Versioned narrow control plane for patched native Hermes cron.

Hermes alone owns due-time calculation, claims, attempts and execution. This
module owns trusted scope registration and result readback, never a timer.
Schedule credentials remain process-local; the host restores them from its
encrypted registry. The native required-admission gate denies until restoration.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import pathlib
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .neurobro_bridge import Bridge, HERMES_PIN

PROTOCOL_VERSION = 1
PATCH_ID = "neurobro-hermes-cron-bridge-v2"
# Guidance, not an authority gate. The required native admission hook obtains a
# freshly prepared host manifest/token before any model work is allowed.
CONTEXT_REMINDER = "Before doing work call context.current to read current owner preferences and source context; if it fails stop."


class CronError(RuntimeError):
    pass


class NativeCron:
    """Supported functions after the exact reviewed source patch is applied."""
    def __init__(self):
        from cron import jobs, scheduler, executions
        if any(getattr(module, "NEUROBRO_CRON_PROTOCOL_VERSION", None) != PROTOCOL_VERSION or getattr(module, "NEUROBRO_CRON_PATCH_ID", None) != PATCH_ID or getattr(module, "NEUROBRO_CRON_SOURCE_PIN", None) != HERMES_PIN
               for module in (jobs, scheduler, executions)):
            raise CronError("native_cron_extension_unavailable")
        self.jobs, self.scheduler, self.executions = jobs, scheduler, executions

    def create(self, **kwargs):
        return self.scheduler.create_job_with_scheduler_registration(**kwargs)

    def get(self, job_id):
        return self.jobs.get_job(job_id)

    def list(self):
        return self.jobs.list_jobs(include_disabled=True)

    def control(self, job_id, action):
        # Native pause/resume/remove accept either ID or name. The trusted
        # control plane accepts an exact stored ID only: reconciliation after
        # removal must never resolve an unrelated job whose name equals it.
        # The pinned native lock is reentrant and shared with its scheduler and
        # CLI mutations. Keep exact-ID validation and name-capable helpers in
        # one critical section so removal cannot introduce an alias race.
        with self.jobs._jobs_lock():
            job = self.jobs.get_job(job_id)
            if job is None:
                if action == "cancel":
                    return {"id": job_id, "removed": True}
                raise CronError("native_schedule_missing")
            if job.get("id") != job_id:
                raise CronError("native_schedule_scope_drift")
            if action == "pause":
                result = self.jobs.pause_job(job_id, reason="Trusted host paused schedule")
            elif action == "resume":
                result = self.jobs.resume_job(job_id)
            elif action == "cancel":
                result = {"id": job_id, "removed": self.jobs.remove_job(job_id)}
            else:
                raise CronError("invalid_schedule_control")
        self.scheduler._notify_provider_jobs_changed()
        return result

    def execution(self, execution_id):
        return self.executions.get_execution(execution_id)


class CronExtension:
    def __init__(self, *, native: Any, bridge: Bridge, state_path: str,
                 output_root: str, broker: Callable[[str, str, dict], dict]):
        self.native, self.bridge, self.broker = native, bridge, broker
        self.output_root = pathlib.Path(output_root).resolve(strict=True)
        pathlib.Path(state_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(state_path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS schedules(
            key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, credential_hash TEXT NOT NULL,
            prompt_hash TEXT NOT NULL, job_id TEXT UNIQUE, phase TEXT NOT NULL)""")
        self.db.commit()
        self.lock = threading.RLock()
        self.credentials: dict[str, str] = {}
        # In-flight callbacks are process-local. A control transition must
        # invalidate their generation even if pause is followed by resume.
        self.admission_revisions: dict[str, int] = {}

    def close(self):
        with self.lock:
            self.db.close()
            self.credentials.clear()

    @staticmethod
    def digest(text: str):
        return hashlib.sha256(text.encode()).hexdigest()

    def _row(self, key: str):
        row = self.db.execute("SELECT key,fingerprint,credential_hash,prompt_hash,job_id,phase FROM schedules WHERE key=?", (key,)).fetchone()
        return dict(zip(("key", "fingerprint", "credential_hash", "prompt_hash", "job_id", "phase"), row)) if row else None

    def _job_row(self, job_id: str):
        row = self.db.execute("SELECT key FROM schedules WHERE job_id=?", (job_id,)).fetchone()
        return self._row(row[0]) if row else None

    def bind(self, key: str, credential: str):
        with self.lock:
            row = self._row(key)
            if not row or row["phase"] == "cancelled" or not hmac.compare_digest(row["credential_hash"], self.digest(credential)):
                raise CronError("schedule_binding_conflict")
            self.credentials[key] = credential
        return {"ok": True, "key": key}

    def create(self, body: dict):
        if set(body) != {"key", "name", "schedule", "instruction", "schedule_context"} or not all(isinstance(v, str) and v and len(v) <= 32768 for v in body.values()):
            raise CronError("invalid_schedule_request")
        key, credential = body["key"], body["schedule_context"]
        fingerprint = self.digest(json.dumps({k: body[k] for k in ("key", "name", "schedule", "instruction")}, sort_keys=True))
        prompt = CONTEXT_REMINDER + "\n\n" + body["instruction"]
        with self.lock:
            row = self._row(key)
            if row and (row["fingerprint"] != fingerprint or row["credential_hash"] != self.digest(credential)):
                raise CronError("schedule_idempotency_conflict")
            if not row:
                self.db.execute("INSERT INTO schedules VALUES(?,?,?,?,?,?)", (key, fingerprint, self.digest(credential), self.digest(prompt), None, "creating"))
                self.db.commit()
                # First create is PAUSED. A crash before storing the native ID
                # cannot leave an unbound recurring executor running.
                job = self.native.create(prompt=prompt, schedule=body["schedule"], name=body["name"],
                                         deliver="local", failure_deliver="local", enabled_toolsets=["neurobro"],
                                         paused=True, required_admission="neurobro", admission_key=key)
                self.db.execute("UPDATE schedules SET job_id=?,phase='created' WHERE key=?", (job["id"], key))
                self.db.commit()
                row = self._row(key)
            if not row["job_id"]:
                # Exact persisted trusted marker, never prompt matching or mtime.
                candidates = [job for job in self.native.list() if job.get("required_admission") == "neurobro" and job.get("admission_key") == key]
                if len(candidates) != 1:
                    raise CronError("schedule_creation_unknown" if not candidates else "schedule_creation_conflict")
                self.db.execute("UPDATE schedules SET job_id=?,phase='created' WHERE key=?", (candidates[0]["id"], key))
                self.db.commit()
                row = self._row(key)
            self.bind(key, credential)
            self._verify_job(row, self.native.get(row["job_id"]))
            if row["phase"] == "created":
                job = self._native_control(row, "resume")
                self.db.execute("UPDATE schedules SET phase='registered' WHERE key=?", (key,))
                self.db.commit()
            else:
                job = self.native.get(row["job_id"])
            self._verify_job(row, job)
            return {"ok": True, "job": job}

    def _verify_job(self, row, job):
        if not job or job.get("id") != row["job_id"] or job.get("required_admission") != "neurobro" or job.get("admission_key") != row["key"] or job.get("deliver") != "local" or job.get("failure_deliver") != "local" or job.get("enabled_toolsets") != ["neurobro"] or not isinstance(job.get("prompt"), str) or not job["prompt"].startswith(CONTEXT_REMINDER + "\n\n") or self.digest(job["prompt"]) != row["prompt_hash"]:
            raise CronError("native_schedule_scope_drift")

    def status(self, job_id: str):
        with self.lock:
            row = self._job_row(job_id)
            if not row:
                raise CronError("schedule_not_owned")
            return {"ok": True, "job": self.native.get(job_id), "scopeRegistered": row["key"] in self.credentials,
                    "phase": row["phase"]}

    def lookup(self, key: str):
        """Read-only reconciliation by the persisted trusted admission marker.

        Never binds a credential, creates a job, stores an ID or resumes work.
        The management registration key is required by the HTTP route.
        """
        with self.lock:
            row = self._row(key)
            if not row:
                raise CronError("schedule_not_owned")
            candidates = [job for job in self.native.list()
                          if job.get("required_admission") == "neurobro" and job.get("admission_key") == key]
            if len(candidates) > 1:
                raise CronError("schedule_creation_conflict")
            if not candidates:
                if row["job_id"] and self.native.get(row["job_id"]) is not None:
                    raise CronError("native_schedule_scope_drift")
                return {"ok": True, "key": key, "job": None, "absenceVerified": True, "phase": row["phase"]}
            job = candidates[0]
            if row["job_id"] and row["job_id"] != job.get("id"):
                raise CronError("native_schedule_scope_drift")
            self._verify_job({**row, "job_id": job.get("id")}, job)
            return {"ok": True, "key": key, "job": job, "scopeVerified": True, "phase": row["phase"]}

    def _native_control(self, row, action):
        self.native.control(row["job_id"], action)
        # Native helpers can return None/False without raising. A successful
        # transport response is not proof that resume/pause/removal occurred.
        # Read the exact owned job after dispatch before acknowledging control.
        job = self.native.get(row["job_id"])
        if action == "cancel":
            if job is not None:
                raise CronError("native_schedule_cancel_unconfirmed")
            return {"id": row["job_id"], "removed": True}
        self._verify_job(row, job)
        if job.get("enabled") is not (action == "resume"):
            raise CronError("native_schedule_control_unconfirmed")
        return job

    def control(self, job_id: str, action: str):
        if action not in {"pause", "resume", "cancel"}:
            raise CronError("invalid_schedule_control")
        with self.lock:
            row = self._job_row(job_id)
            if not row and action == "cancel":
                # A lost paused-create response can leave only the immutable
                # admission marker. Trusted cancellation may adopt that exact
                # observed identity solely to withdraw it, never to resume it.
                job = self.native.get(job_id)
                candidate = self._row(job.get("admission_key")) if isinstance(job, dict) else None
                if candidate and candidate["job_id"] is None:
                    self._verify_job({**candidate, "job_id": job_id}, job)
                    self.db.execute("UPDATE schedules SET job_id=? WHERE key=?", (job_id, candidate["key"]))
                    self.db.commit()
                    row = self._job_row(job_id)
            if not row:
                raise CronError("schedule_not_owned")
            if action == "resume":
                if row["key"] not in self.credentials or row["phase"] == "cancelled":
                    raise CronError("schedule_context_unavailable")
                self._verify_job(row, self.native.get(job_id))
            self.admission_revisions[row["key"]] = self.admission_revisions.get(row["key"], 0) + 1
            if action != "resume":
                # Deny a racing new admission before native pause/remove.
                self.db.execute("UPDATE schedules SET phase=? WHERE key=?", ("cancelled" if action == "cancel" else "paused", row["key"]))
                self.db.commit()
                if action == "cancel":
                    self.credentials.pop(row["key"], None)
            result = self._native_control(row, action)
            if action == "resume":
                self.db.execute("UPDATE schedules SET phase='registered' WHERE key=?", (row["key"],))
                self.db.commit()
            return {"ok": True, "job": result, "activeExecutionsMayRemain": action != "resume"}

    def admit(self, *, job_id: str, execution_id: str, task_id: str, admission_namespace: str, **_unused):
        # This is a REQUIRED policy hook in the versioned native patch, not an
        # observer/middleware/prompt convention. Every failure returns deny.
        if admission_namespace != "neurobro":
            return None  # Another namespace's owning policy must decide it.
        try:
            with self.lock:
                row = self._job_row(job_id)
                if admission_namespace != "neurobro" or not row or row["phase"] != "registered" or task_id != f"cron:{job_id}:{execution_id}":
                    raise CronError("schedule_admission_denied")
                credential = self.credentials.get(row["key"])
                admission_revision = self.admission_revisions.get(row["key"], 0)
                if not credential:
                    raise CronError("schedule_context_unavailable")
                job = self.native.get(job_id)
                self._verify_job(row, job)
                if not job.get("enabled"):
                    raise CronError("schedule_paused")
            # Broker admission may wait for a fresh context or transport timeout.
            # Do not block status/cancel/binding management behind that callback.
            # Recheck the exact current native scope before allowing its late
            # response to bind a session; pause/cancel must win this race.
            response = self.broker(credential, "admit", {"job_id": job_id, "execution_id": execution_id, "task_id": task_id})
            with self.lock:
                row = self._job_row(job_id)
                if not row or row["phase"] != "registered" or self.credentials.get(row["key"]) != credential or self.admission_revisions.get(row["key"], 0) != admission_revision:
                    raise CronError("schedule_admission_denied")
                job = self.native.get(job_id)
                self._verify_job(row, job)
                if not job.get("enabled"):
                    raise CronError("schedule_paused")
                if response.get("ok") is not True or not isinstance(response.get("tool_context"), str) or not response["tool_context"]:
                    raise CronError("fresh_schedule_grant_denied")
                self.bridge.bind_session(task_id, f"cron:{job_id}:{execution_id}", response["tool_context"])
                return {"action": "allow"}
        except Exception:
            return {"action": "deny", "reason": "fresh_schedule_grant_denied"}

    def result(self, job_id: str, execution_id: str):
        with self.lock:
            row = self._job_row(job_id)
            if not row:
                raise CronError("schedule_not_owned")
            execution = self.native.execution(execution_id)
            if not execution or execution.get("job_id") != job_id or execution.get("id") != execution_id:
                raise CronError("execution_binding_mismatch")
            outcome = execution.get("status")
            if outcome not in {"completed", "failed", "unknown"}:
                raise CronError("execution_unsettled")
            path, expected = execution.get("output_file"), execution.get("output_sha256")
            manifest = {"job_id": job_id, "execution_id": execution_id, "task_id": f"cron:{job_id}:{execution_id}", "outcome": outcome,
                        "output_file": path, "output_sha256": expected}
            if path is not None:
                file = pathlib.Path(path)
                resolved = file.resolve(strict=True)
                if file.is_symlink() or not resolved.is_relative_to(self.output_root) or not resolved.is_file():
                    raise CronError("cron_output_scope_violation")
                with resolved.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if not isinstance(expected, str) or not hmac.compare_digest(digest, expected):
                    raise CronError("cron_output_readback_mismatch")
                manifest["output_file"] = str(resolved)
                manifest["size"] = resolved.stat().st_size
            elif expected is not None:
                raise CronError("cron_output_readback_mismatch")
            return {"ok": True, "manifest": manifest}

    def complete(self, *, job_id: str, execution_id: str, **_unused):
        try:
            result = self.result(job_id, execution_id)
            with self.lock:
                row = self._job_row(job_id)
                credential = self.credentials.get(row["key"])
                if not credential:
                    raise CronError("schedule_context_unavailable")
            # Host completion reads back GET /cron/results over another handler
            # thread; never hold this lock across the broker's callback.
            response = self.broker(credential, "complete", result["manifest"])
            return {"ok": response.get("ok") is True,
                    **({"reconciliation_required": True} if response.get("reconciliation_required") is True else {})}
        except Exception:
            # Durable native row remains readable for trusted host reconciliation.
            return {"ok": False, "error": "cron_completion_requires_reconciliation"}

    def register(self, ctx):
        ctx.register_hook("cron_execution_admission", self.admit)
        ctx.register_hook("cron_execution_completed", self.complete)


class CronManagementServer:
    def __init__(self, extension: CronExtension, bind: tuple[str, int], registration_key: str):
        if bind[0] != "127.0.0.1" or len(registration_key) < 32:
            raise CronError("invalid_cron_control_config")
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def setup(self):
                super().setup()
                self.connection.settimeout(10)

            def handle_request(self, post=False):
                try:
                    if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + registration_key).encode()):
                        code, result = 401, {"ok": False, "error": "registration_denied"}
                    else:
                        parts = self.path.strip("/").split("/")
                        body = None
                        if post:
                            length = int(self.headers.get("Content-Length", "0"))
                            if length < 0 or length > 65536:
                                raise CronError("invalid_request")
                            body = json.loads(self.rfile.read(length) or b"{}")
                            if not isinstance(body, dict):
                                raise CronError("invalid_request")
                        if parts == ["cron", "ready"] and not post:
                            result = {"ok": True, "protocolVersion": PROTOCOL_VERSION, "patchId": PATCH_ID, "hermesPin": HERMES_PIN, "nativeScheduler": True, "durableExecutionManifest": True}
                        elif parts == ["cron", "jobs"] and post:
                            result = extension.create(body)
                        elif parts == ["cron", "bindings"] and post and set(body) == {"key", "schedule_context"}:
                            result = extension.bind(body["key"], body["schedule_context"])
                        elif len(parts) == 3 and parts[:2] == ["cron", "jobs"] and not post:
                            result = extension.status(parts[2])
                        elif len(parts) == 3 and parts[:2] == ["cron", "lookup"] and not post:
                            result = extension.lookup(parts[2])
                        elif len(parts) == 4 and parts[:2] == ["cron", "jobs"] and post:
                            result = extension.control(parts[2], parts[3])
                        elif len(parts) == 4 and parts[:2] == ["cron", "results"] and not post:
                            result = extension.result(parts[2], parts[3])
                        else:
                            raise CronError("unknown_cron_control_route")
                        code = 200
                except CronError as exc:
                    code, result = 409, {"ok": False, "error": str(exc)}
                except Exception:
                    code, result = 500, {"ok": False, "error": "cron_control_unknown"}
                raw = json.dumps(result).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request(post=True)
        self.server = ThreadingHTTPServer(bind, Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True, name="neurobro-cron-control")

    @property
    def address(self):
        return self.server.server_address

    def start(self):
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def bootstrap(ctx, bridge: Bridge):
    """Called by the trusted plugin's register(), only under explicit config.

    Stock Hermes fails at NativeCron construction; enabling this is operator
    owned and does not patch/install/change a profile automatically.
    """
    from urllib.parse import urlsplit, urlunsplit
    from .management import BrokerHttpClient, parse_bind
    from hermes_cli.config import get_hermes_home
    bind = os.environ.get("NEUROBRO_CRON_BIND")
    if not bind:
        return None
    key = os.environ.get("NEUROBRO_BRIDGE_REGISTRATION_KEY", "")
    broker_url = os.environ.get("NEUROBRO_BROKER_URL", "")
    # Validate the trusted local endpoint with the same no-proxy/no-redirect
    # transport used by the scoped tool bridge.
    BrokerHttpClient(broker_url)
    parts = urlsplit(broker_url)
    clients = {action: BrokerHttpClient(urlunsplit((parts.scheme, parts.netloc, "/schedules/" + action, "", "")))
               for action in ("admit", "complete")}
    home = get_hermes_home()
    output_root = home / "cron" / "output"
    output_root.mkdir(parents=True, exist_ok=True)
    extension = CronExtension(native=NativeCron(), bridge=bridge,
                              state_path=str(home / "neurobro-cron-control.db"), output_root=str(output_root),
                              broker=lambda token, action, payload: clients[action].call(token, payload))
    extension.register(ctx)
    server = CronManagementServer(extension, parse_bind(bind), key)
    server.start()
    return extension, server
