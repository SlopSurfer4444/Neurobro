"""Imported pinned native tick/claims/output proof, with no model or network.

Run using the pinned runtime's venv and NEUROBRO_HERMES_RUNTIME pointing to
its checkout. When that checkout is already patched, supply the separately
verified five-file source root in NEUROBRO_HERMES_PRISTINE_SOURCE. Only the pre-agent prompt preparation is replaced by
a synthetic executor; the production required admission, plugin dispatch,
due-time calculation, SQLite claims, output/hash and completion run unchanged.
"""
from __future__ import annotations
import importlib.util
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import socket
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get("NEUROBRO_HERMES_RUNTIME"), "Pinned runtime not supplied")
class ImportedNativeCronLifecycle(unittest.TestCase):
    def test_recurring_native_tick_restart_and_cancel(self):
        runtime = Path(os.environ["NEUROBRO_HERMES_RUNTIME"]).resolve(strict=True)
        pristine = Path(os.environ.get("NEUROBRO_HERMES_PRISTINE_SOURCE", str(runtime))).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="neurobro-imported-cron-") as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir()
            home.joinpath("config.yaml").write_text("auth:\n  adopt_external_logins: false\nplugins:\n  enabled: []\ncron:\n  max_parallel_jobs: 1\n", encoding="utf-8")
            previous = os.environ.copy()
            old_connect = socket.socket.connect
            # No inherited credentials, secret-source profiles or outbound calls.
            for key in list(os.environ):
                if key.endswith(("_API_KEY", "_TOKEN")) or key.startswith(("NEUROBRO_", "CODEX_", "OPENAI_", "ANTHROPIC_", "TELEGRAM_")):
                    os.environ.pop(key, None)
            os.environ.update(HERMES_HOME=str(home), HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "appdata"), LOCALAPPDATA=str(home / "local"))
            socket.socket.connect = lambda *_: (_ for _ in ()).throw(AssertionError("Offline fixture attempted network"))
            extensions = []
            try:
                spec = importlib.util.spec_from_file_location("native_lifecycle_patch_builder", ROOT / "tools/hermes/patches/build_cron_patch.py")
                builder = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(builder)
                overlay = root / "overlay"
                builder.build(pristine, overlay)
                # Overlay only the five reviewed files; all sibling dependencies
                # come from the verified, pristine checkout.
                sys.path.insert(0, str(runtime))
                for name in ("hermes_cli", "cron"):
                    package = importlib.util.spec_from_file_location(name, runtime / name / "__init__.py", submodule_search_locations=[str(overlay / name), str(runtime / name)])
                    module = importlib.util.module_from_spec(package)
                    sys.modules[name] = module
                    package.loader.exec_module(module)
                from cron import jobs, scheduler, executions
                from hermes_cli import plugins
                bridge_spec = importlib.util.spec_from_file_location("native_lifecycle_bridge", ROOT / "tools/hermes/__init__.py", submodule_search_locations=[str(ROOT / "tools/hermes")])
                bridge_module = importlib.util.module_from_spec(bridge_spec)
                sys.modules[bridge_spec.name] = bridge_module
                bridge_spec.loader.exec_module(bridge_module)
                from native_lifecycle_bridge.neurobro_bridge import Bridge
                from native_lifecycle_bridge.cron_extension import CronExtension, NativeCron
                from tools.process_registry import restart_safe_gateway_child_argv
                if os.name == "nt":
                    self.assertEqual(restart_safe_gateway_child_argv(["synthetic"], unit_suffix="fixture", require_restart_safe_scope=True).mode, "in_process")
                manager = plugins.get_plugin_manager()
                manager._discovered = True  # explicit fixture registration, no installed plugins
                manifest = plugins.parse_manifest_file(ROOT / "tools/hermes/plugin.yaml", ROOT / "tools/hermes", "user", "")
                ctx = plugins.PluginContext(manifest, manager)
                admitted, tool_calls, completed = [], [], []
                authority = {"allow": True, "preferences": "initial"}
                def broker(credential, action, payload):
                    self.assertEqual(credential, "fixture-schedule-credential")
                    if action == "admit":
                        if not authority["allow"]:
                            return {"ok": False}
                        token = "execution-token-" + payload["execution_id"]
                        admitted.append((payload["execution_id"], token, authority["preferences"]))
                        return {"ok": True, "tool_context": token}
                    self.assertEqual(action, "complete")
                    completed.append(payload)
                    return {"ok": True}
                def call(token, request):
                    self.assertEqual(request["name"], "observation.collect")
                    self.assertTrue(token.startswith("execution-token-"))
                    tool_calls.append(token)
                    return {"ok": True, "value": {"pending": []}}
                output = home / "cron/output"
                output.mkdir(parents=True)
                def extension():
                    instance = CronExtension(native=NativeCron(), bridge=Bridge(call), state_path=str(home / "control.db"), output_root=str(output), broker=broker)
                    extensions.append(instance)
                    return instance
                current = extension()
                current.register(ctx)
                original_prepare = scheduler._prepare_job_prompt
                def synthetic_prepare(job, *_):
                    effective_id = "cron:" + job["id"] + ":" + job["execution_id"]
                    result = json.loads(current.bridge.handle({"name": "observation.collect", "args": {}}, task_id=effective_id))
                    self.assertTrue(result["ok"])
                    return ((True, "synthetic monitored no-change", "[SILENT]", None), None)
                scheduler._prepare_job_prompt = synthetic_prepare
                original_jobs_clock, original_scheduler_clock = jobs._hermes_now, scheduler._hermes_now
                clock = [original_jobs_clock()]
                jobs._hermes_now = scheduler._hermes_now = lambda: clock[0]
                body = {"key": "fixture-recurring-monitor", "name": "fixture", "schedule": "every 1h", "instruction": "context.current, observation.collect, monitors.decide", "schedule_context": "fixture-schedule-credential"}
                job = current.create(body)["job"]
                job_id = job["id"]
                def next_scheduled_occurrence():
                    # Advance the fixture clock to the native-computed due time.
                    # No trigger_job/run-now/manual collection path is used.
                    clock[0] = datetime.fromisoformat(jobs.get_job(job_id)["next_run_at"]) + timedelta(seconds=1)
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 0)
                next_scheduled_occurrence()
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 1)
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 0)
                first = executions.list_executions(job_id=job_id)
                self.assertEqual(len(first), 1)
                self.assertEqual(first[0]["status"], "completed")
                self.assertEqual(completed[0]["execution_id"], first[0]["id"])
                self.assertEqual(current.result(job_id, first[0]["id"])["manifest"]["output_sha256"], first[0]["output_sha256"])
                self.assertEqual(len(tool_calls), 1)
                # Simulate plugin process state loss. Persistent schedule stays,
                # but no credential is silently recovered from plaintext state.
                current.close()
                extensions.remove(current)
                current = extension()
                manager._hooks.clear()
                current.register(ctx)
                next_scheduled_occurrence()
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 1)
                self.assertEqual(executions.list_executions(job_id=job_id)[0]["status"], "failed")
                self.assertEqual(len(tool_calls), 1)
                current.bind(body["key"], body["schedule_context"])
                authority["preferences"] = "changed after restart"
                next_scheduled_occurrence()
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 1)
                rows = executions.list_executions(job_id=job_id)
                self.assertEqual(len(rows), 3)
                self.assertEqual(rows[0]["status"], "completed")
                self.assertEqual(admitted[-1][2], "changed after restart")
                self.assertNotEqual(admitted[0][1], admitted[-1][1])
                authority["allow"] = False
                next_scheduled_occurrence()
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 1)
                self.assertEqual(executions.list_executions(job_id=job_id)[0]["status"], "failed")
                self.assertEqual(len(tool_calls), 2, "Revoked authority must deny before synthetic collection")
                current.control(job_id, "cancel")
                self.assertEqual(scheduler.tick(verbose=False, sync=True), 0)
                self.assertIsNone(jobs.get_job(job_id))
                self.assertEqual(len(tool_calls), 2)
                scheduler._prepare_job_prompt = original_prepare
                jobs._hermes_now, scheduler._hermes_now = original_jobs_clock, original_scheduler_clock
            finally:
                for instance in extensions:
                    instance.close()
                socket.socket.connect = old_connect
                os.environ.clear()
                os.environ.update(previous)


if __name__ == "__main__":
    unittest.main()
