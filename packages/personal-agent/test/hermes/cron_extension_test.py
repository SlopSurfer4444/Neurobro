"""Offline control/admission/results; scheduler timing is native, never ours."""
import hashlib
from contextlib import nullcontext
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("cron_test_bridge", ROOT / "tools/hermes/__init__.py", submodule_search_locations=[str(ROOT / "tools/hermes")])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from cron_test_bridge.neurobro_bridge import Bridge
from cron_test_bridge.cron_extension import CONTEXT_REMINDER, CronError, CronExtension, CronManagementServer, NativeCron


class NativeFixture:
    def __init__(self):
        self.jobs, self.executions, self.creates = {}, {}, 0
        self.lose_creation = False

    def create(self, **kwargs):
        self.creates += 1
        job = {"id": f"job{self.creates}", "enabled": False, **kwargs}
        self.jobs[job["id"]] = job
        if self.lose_creation:
            self.lose_creation = False
            raise RuntimeError("lost response after native paused create")
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)

    def list(self):
        return list(self.jobs.values())

    def control(self, job_id, action):
        if action == "cancel":
            return {"id": job_id, "removed": bool(self.jobs.pop(job_id, None))}
        self.jobs[job_id]["enabled"] = action == "resume"
        return self.jobs[job_id]

    def execution(self, execution_id):
        return self.executions.get(execution_id)


class CronExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.native = NativeFixture()
        self.calls = []
        self.allow = True
        def broker(token, action, payload):
            self.calls.append((token, action, payload))
            return {"ok": self.allow, "tool_context": "fresh-execution-token"}
        self.bridge = Bridge(lambda token, args: {"ok": True, "value": "receipt"})
        self.options = {"native": self.native, "bridge": self.bridge, "state_path": str(self.root / "control.db"), "output_root": str(self.root), "broker": broker}
        self.extension = CronExtension(**self.options)
        self.body = {"key": "schedule-operation", "name": "fixture", "schedule": "every 1h", "instruction": "Check fixture", "schedule_context": "scope-for-this-schedule"}

    def tearDown(self):
        self.extension.close()
        self.temp.cleanup()

    def admit(self, job_id="job1", execution_id="execution1"):
        return self.extension.admit(job_id=job_id, execution_id=execution_id, task_id=f"cron:{job_id}:{execution_id}", admission_namespace="neurobro")

    def test_create_replay_scope_and_pause_never_resumes_on_replay(self):
        result = self.extension.create(self.body)
        job = result["job"]
        self.assertTrue(job["enabled"])
        self.assertEqual((job["deliver"], job["failure_deliver"], job["enabled_toolsets"]), ("local", "local", ["neurobro"]))
        self.assertEqual(job["required_admission"], "neurobro")
        self.assertEqual(job["prompt"], CONTEXT_REMINDER + "\n\n" + self.body["instruction"])
        self.assertEqual(self.extension._row(self.body["key"])["prompt_hash"], hashlib.sha256(job["prompt"].encode()).hexdigest())
        self.extension.create(self.body)
        self.assertEqual(self.native.creates, 1)
        self.extension.control("job1", "pause")
        self.assertFalse(self.extension.create(self.body)["job"]["enabled"])
        self.assertEqual(self.admit()["action"], "deny")
        with self.assertRaisesRegex(CronError, "idempotency_conflict"):
            self.extension.create({**self.body, "instruction": "changed"})

    def test_context_reminder_is_immutable_native_prompt_scope(self):
        self.extension.create(self.body)
        self.native.jobs["job1"]["prompt"] = self.body["instruction"]
        self.assertEqual(self.admit()["action"], "deny")
        self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(CronError, "scope_drift"):
            self.extension.create(self.body)
        # Even a pre-extension stored hash cannot silently grandfather a job
        # that lacks the required context reminder. No live prompt migration.
        self.extension.db.execute("UPDATE schedules SET prompt_hash=? WHERE key=?", (self.extension.digest(self.body["instruction"]), self.body["key"]))
        self.extension.db.commit()
        self.assertEqual(self.admit()["action"], "deny")
        self.assertEqual(self.calls, [])

    def test_fresh_broker_grant_each_execution_denies_expired_scope(self):
        self.extension.create(self.body)
        self.assertEqual(self.admit()["action"], "allow")
        self.assertEqual(self.calls[0], ("scope-for-this-schedule", "admit", {"job_id": "job1", "execution_id": "execution1", "task_id": "cron:job1:execution1"}))
        self.assertTrue(json.loads(self.bridge.handle({"name": "read", "args": {}}, task_id="cron:job1:execution1"))["ok"])
        self.allow = False
        self.assertEqual(self.admit(execution_id="execution2")["action"], "deny")
        self.assertFalse(json.loads(self.bridge.handle({"name": "read", "args": {}}, task_id="cron:job1:execution2"))["ok"])
        self.assertEqual(self.native.creates, 1)

    def test_restart_holds_until_exact_host_scope_restoration(self):
        self.extension.create(self.body)
        self.extension.close()
        self.extension = CronExtension(**self.options)
        self.assertEqual(self.admit()["action"], "deny")
        with self.assertRaisesRegex(CronError, "binding_conflict"):
            self.extension.bind(self.body["key"], "foreign-token")
        self.extension.bind(self.body["key"], self.body["schedule_context"])
        self.assertEqual(self.admit()["action"], "allow")
        self.assertNotIn(self.body["schedule_context"].encode(), (self.root / "control.db").read_bytes())

    def test_crash_after_paused_native_create_recovers_exact_marker_without_second_create(self):
        self.native.lose_creation = True
        with self.assertRaises(RuntimeError):
            self.extension.create(self.body)
        self.assertFalse(self.native.jobs["job1"]["enabled"])
        self.assertTrue(self.extension.create(self.body)["job"]["enabled"])
        self.assertEqual(self.native.creates, 1)

    def test_resume_noop_never_registers_created_job_or_acknowledges_control(self):
        original = self.native.control
        self.native.control = lambda *_: None
        with self.assertRaisesRegex(CronError, "control_unconfirmed"):
            self.extension.create(self.body)
        self.assertEqual(self.extension._row(self.body["key"])["phase"], "created")
        self.assertEqual(self.admit()["action"], "deny")
        self.native.control = original
        self.assertTrue(self.extension.create(self.body)["job"]["enabled"])
        self.assertEqual(self.native.creates, 1)
        self.extension.control("job1", "pause")
        self.native.control = lambda *_: None
        with self.assertRaisesRegex(CronError, "control_unconfirmed"):
            self.extension.control("job1", "resume")
        self.assertEqual(self.extension._row(self.body["key"])["phase"], "paused")

    def test_lookup_reads_exact_marker_without_binding_storing_identity_or_enabling(self):
        self.native.lose_creation = True
        with self.assertRaises(RuntimeError):
            self.extension.create(self.body)
        before = self.extension._row(self.body["key"])
        result = self.extension.lookup(self.body["key"])
        self.assertTrue(result["scopeVerified"])
        self.assertEqual(result["job"]["id"], "job1")
        self.assertFalse(result["job"]["enabled"])
        self.assertEqual(self.extension._row(self.body["key"]), before)
        self.assertEqual(self.extension.credentials, {})
        self.assertEqual(self.native.creates, 1)
        self.native.jobs["job2"] = {**self.native.jobs["job1"], "id": "job2"}
        with self.assertRaisesRegex(CronError, "creation_conflict"):
            self.extension.lookup(self.body["key"])
        self.native.jobs.clear()
        self.assertTrue(self.extension.lookup(self.body["key"])["absenceVerified"])
        self.assertEqual(self.extension._row(self.body["key"]), before)

    def test_cancel_adopts_exact_unknown_native_identity_only_to_remove_never_to_resume(self):
        self.native.lose_creation = True
        with self.assertRaises(RuntimeError):
            self.extension.create(self.body)
        found = self.extension.lookup(self.body["key"])
        self.assertEqual(self.extension._row(self.body["key"])["job_id"], None)
        with self.assertRaisesRegex(CronError, "not_owned"):
            self.extension.control(found["job"]["id"], "resume")
        self.assertTrue(self.extension.control(found["job"]["id"], "cancel")["job"]["removed"])
        self.assertEqual(self.extension._row(self.body["key"])["phase"], "cancelled")
        self.assertEqual(self.native.jobs, {})
        self.assertEqual(self.native.creates, 1)
        self.assertEqual(self.extension.credentials, {})

    def test_cancel_noop_stays_denied_and_reconciles_exact_absence(self):
        self.extension.create(self.body)
        original = self.native.control
        self.native.control = lambda *_: {"id": "job1", "removed": False}
        with self.assertRaisesRegex(CronError, "cancel_unconfirmed"):
            self.extension.control("job1", "cancel")
        self.assertIn("job1", self.native.jobs)
        self.assertEqual(self.extension._row(self.body["key"])["phase"], "cancelled")
        self.assertEqual(self.admit()["action"], "deny")
        self.native.control = original
        self.assertTrue(self.extension.control("job1", "cancel")["job"]["removed"])
        self.assertTrue(self.extension.control("job1", "cancel")["job"]["removed"])

    def test_native_control_does_not_resolve_absent_id_as_an_unrelated_job_name(self):
        from types import SimpleNamespace
        calls = []
        native = object.__new__(NativeCron)
        native.jobs = SimpleNamespace(get_job=lambda job_id: None,
                                     _jobs_lock=nullcontext,
                                     remove_job=lambda job_id: calls.append(("remove", job_id)),
                                     pause_job=lambda job_id, **kwargs: calls.append(("pause", job_id)),
                                     resume_job=lambda job_id: calls.append(("resume", job_id)))
        native.scheduler = SimpleNamespace(_notify_provider_jobs_changed=lambda: calls.append(("notify",)))
        self.assertTrue(native.control("removed-id", "cancel")["removed"])
        for action in ("pause", "resume"):
            with self.assertRaisesRegex(CronError, "schedule_missing"):
                native.control("removed-id", action)
        self.assertEqual(calls, [])

    def test_scope_drift_cancel_and_forged_runtime_identity_denied(self):
        self.extension.create(self.body)
        self.assertEqual(self.extension.admit(job_id="job1", execution_id="ex", task_id="cron:other:ex", admission_namespace="neurobro")["action"], "deny")
        self.native.jobs["job1"]["failure_deliver"] = "origin"
        self.assertEqual(self.admit()["action"], "deny")
        self.native.jobs["job1"]["failure_deliver"] = "local"
        self.extension.control("job1", "cancel")
        self.assertEqual(self.admit()["action"], "deny")
        with self.assertRaisesRegex(CronError, "context_unavailable"):
            self.extension.control("job1", "resume")

    def test_exact_execution_manifest_hash_readback_and_completion(self):
        self.extension.create(self.body)
        output = self.root / "execution-specific.txt"
        output.write_bytes(b"exact result")
        self.native.executions["execution1"] = {"id": "execution1", "job_id": "job1", "status": "completed", "output_file": str(output), "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
        manifest = self.extension.result("job1", "execution1")["manifest"]
        self.assertEqual(manifest["output_sha256"], hashlib.sha256(b"exact result").hexdigest())
        self.assertTrue(self.extension.complete(job_id="job1", execution_id="execution1")["ok"])
        output.write_bytes(b"tampered result")
        with self.assertRaisesRegex(CronError, "readback_mismatch"):
            self.extension.result("job1", "execution1")
        self.assertFalse(self.extension.complete(job_id="job1", execution_id="execution1")["ok"])
        with self.assertRaisesRegex(CronError, "binding_mismatch"):
            self.extension.result("job1", "wrong-execution")

    def test_control_http_auth_and_exact_routes(self):
        server = CronManagementServer(self.extension, ("127.0.0.1", 0), "k" * 32)
        server.start()
        base = "http://127.0.0.1:" + str(server.address[1])
        try:
            request = Request(base + "/cron/jobs", data=json.dumps(self.body).encode(), headers={"Authorization": "Bearer " + "k" * 32, "Content-Type": "application/json"})
            with urlopen(request, timeout=2) as response:
                self.assertEqual(json.load(response)["job"]["id"], "job1")
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + "/cron/jobs/job1", timeout=2)
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            with urlopen(Request(base + "/cron/ready", headers={"Authorization": "Bearer " + "k" * 32}), timeout=2) as response:
                self.assertTrue(json.load(response)["durableExecutionManifest"])
        finally:
            server.close()

    def test_completion_broker_can_read_native_manifest_on_another_thread(self):
        self.extension.create(self.body)
        self.native.executions["execution1"] = {"id": "execution1", "job_id": "job1", "status": "failed", "output_file": None, "output_sha256": None}
        observed = []
        def broker(_token, action, _payload):
            if action == "complete":
                worker = threading.Thread(target=lambda: observed.append(self.extension.result("job1", "execution1")), daemon=True)
                worker.start()
                worker.join(timeout=1)
                if worker.is_alive():
                    raise RuntimeError("completion readback deadlocked")
                return {"ok": True, "reconciliation_required": True}
            return {"ok": True, "tool_context": "scope"}
        self.extension.broker = broker
        result = self.extension.complete(job_id="job1", execution_id="execution1")
        self.assertEqual(result, {"ok": True, "reconciliation_required": True})
        self.assertEqual(len(observed), 1)

    def test_control_during_waiting_admission_remains_available_and_denies_late_grant(self):
        self.extension.create(self.body)
        started, released = threading.Event(), threading.Event()
        results, status = [], []
        def broker(_credential, _action, _payload):
            started.set()
            if not released.wait(timeout=3):
                raise RuntimeError("fixture admission did not settle")
            return {"ok": True, "tool_context": "late-token"}
        self.extension.broker = broker
        admission = threading.Thread(target=lambda: results.append(self.admit()), daemon=True)
        admission.start()
        self.assertTrue(started.wait(timeout=1))
        management = threading.Thread(target=lambda: status.append(self.extension.control("job1", "cancel")), daemon=True)
        management.start()
        management.join(timeout=1)
        try:
            self.assertFalse(management.is_alive(), "Native control blocked behind broker admission")
            self.assertTrue(status[0]["job"]["removed"])
        finally:
            released.set()
            admission.join(timeout=1)
        self.assertFalse(admission.is_alive())
        self.assertEqual(results, [{"action": "deny", "reason": "fresh_schedule_grant_denied"}])
        with self.assertRaises(Exception):
            self.bridge.assert_registered_session("cron:job1:execution1")

    def test_pause_resume_during_admission_never_revives_its_previous_generation(self):
        self.extension.create(self.body)
        started, released = threading.Event(), threading.Event()
        results = []
        def broker(_credential, _action, _payload):
            started.set()
            if not released.wait(timeout=3):
                raise RuntimeError("fixture admission did not settle")
            return {"ok": True, "tool_context": "old-generation-token"}
        self.extension.broker = broker
        admission = threading.Thread(target=lambda: results.append(self.admit()), daemon=True)
        admission.start()
        self.assertTrue(started.wait(timeout=1))
        try:
            self.extension.control("job1", "pause")
            self.extension.control("job1", "resume")
        finally:
            released.set()
            admission.join(timeout=1)
        self.assertFalse(admission.is_alive())
        self.assertEqual(results, [{"action": "deny", "reason": "fresh_schedule_grant_denied"}])
        with self.assertRaises(Exception):
            self.bridge.assert_registered_session("cron:job1:execution1")


if __name__ == "__main__":
    unittest.main()
