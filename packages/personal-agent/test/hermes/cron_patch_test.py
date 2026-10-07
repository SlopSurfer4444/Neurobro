"""Pinned native cron patch proof with real native functions and SQLite.

Set NEUROBRO_HERMES_SOURCE to the flattened official source packet used by
bridge_test.py. No imports of provider/model/Telegram runtimes are needed.
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import contextvars
import dataclasses
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import inspect
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import threading
import time
import types
from typing import Any, Callable, Dict, Iterator, List, Optional, Union
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("cron_patch_builder", ROOT / "tools/hermes/patches/build_cron_patch.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def functions(source, names, namespace):
    tree = ast.parse(source)
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    if set(node.name for node in selected) != set(names):
        raise AssertionError("Native function missing")
    exec(compile(ast.Module(body=selected, type_ignores=[]), "pinned-patched-native", "exec"), namespace)
    return namespace


@unittest.skipUnless(os.environ.get("NEUROBRO_HERMES_SOURCE"), "Pinned native source packet not supplied")
class NativeCronPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="neurobro-cron-patch-test-")
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        packet = Path(os.environ["NEUROBRO_HERMES_SOURCE"])
        for path in builder.BLOBS:
            destination = self.source / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((packet / path.replace("/", "_")).read_bytes())
        self.planned = builder.plan(self.source)
        self.native = {path: item["after"] for path, item in self.planned.items()}
        self.old_modules = {}

    def tearDown(self):
        for name, original in self.old_modules.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        self.temp.cleanup()

    def module(self, name, **attrs):
        if name not in self.old_modules:
            self.old_modules[name] = sys.modules.get(name)
        module = types.ModuleType(name)
        vars(module).update(attrs)
        sys.modules[name] = module
        return module

    def common(self):
        return {"Optional": Optional, "Dict": Dict, "Any": Any, "List": List, "Union": Union,
                "Callable": Callable, "Iterator": Iterator, "Path": Path, "re": re, "hashlib": hashlib,
                "os": os, "uuid": uuid, "contextmanager": contextlib.contextmanager,
                "math": math,
                "_hermes_now": lambda: datetime(2026, 10, 4, 20, 30, tzinfo=timezone.utc)}

    def test_exact_pin_preflight_fresh_overlay_and_receipt(self):
        destination = self.root / "overlay"
        receipt = builder.build(self.source, destination)
        self.assertEqual(receipt["hermesPin"], builder.PIN)
        self.assertEqual(json.loads((destination / "patch-receipt.json").read_text()), receipt)
        for path, item in receipt["files"].items():
            self.assertEqual(hashlib.sha256((destination / path).read_bytes()).hexdigest(), item["patchedSha256"])
            if path.startswith("cron/"):
                self.assertIn("NEUROBRO_CRON_PROTOCOL_VERSION = 1", self.native[path])
                self.assertIn(f"NEUROBRO_CRON_PATCH_ID = {builder.PATCH_ID!r}", self.native[path])
                self.assertIn(f"NEUROBRO_CRON_SOURCE_PIN = {builder.PIN!r}", self.native[path])
        self.assertIn("cron_execution_completed", (destination / (builder.PATCH_ID + ".patch")).read_text())
        with self.assertRaises(ValueError):
            builder.build(self.source, destination)
        (self.source / "cron/jobs.py").write_bytes((self.source / "cron/jobs.py").read_bytes() + b"\n")
        rejected = self.root / "rejected"
        with self.assertRaises(builder.SourceMismatch):
            builder.build(self.source, rejected)
        self.assertFalse(rejected.exists())

    def admission(self, callback):
        self.module("hermes_cli.plugins", invoke_hook=callback)
        ns = self.common()
        ns.update({"_CancelEventLike": object,
                   "_prepare_job_prompt": lambda *_: ((True, "synthetic pre-agent stop", "", None), None)})
        return functions(self.native["cron/scheduler.py"], {"_require_cron_execution_admission", "run_job"}, ns)

    def test_required_admission_before_scripts_and_models(self):
        seen = []
        ns = self.admission(lambda hook, **kw: seen.append((hook, kw)) or [{"action": "allow"}])
        result = ns["run_job"]({"id": "job", "required_admission": "neurobro", "admission_key": "logical-key"},
                                execution_id="execution")
        self.assertTrue(result[0])
        self.assertEqual(seen, [("cron_execution_admission", {
            "job_id": "job", "execution_id": "execution", "task_id": "cron:job:execution",
            "admission_namespace": "neurobro", "admission_key": "logical-key"})])

    def test_missing_refused_exception_and_missing_execution_fail_closed(self):
        def raises(*_, **__):
            raise RuntimeError("synthetic observer transport error")
        for callback in (lambda *_, **__: [], lambda *_, **__: [{"action": "deny"}],
                         lambda *_, **__: [{"action": "allow"}, {"action": "deny"}],
                         lambda *_, **__: [None], raises):
            ns = self.admission(callback)
            ns["_prepare_job_prompt"] = lambda *_: self.fail("A script/model gate must not run")
            result = ns["run_job"]({"id": "job", "required_admission": "neurobro"}, execution_id="execution")
            self.assertFalse(result[0])
            self.assertIn("required_cron_execution_admission", result[3])
        ns = self.admission(lambda *_, **__: self.fail("No identity means no hook"))
        self.assertFalse(ns["run_job"]({"id": "job", "required_admission": "neurobro"})[0])
        self.assertTrue(ns["run_job"]({"id": "legacy-job"})[0])

    def test_native_hook_dispatch_exception_and_timeout_veto_allow(self):
        source = self.native["hermes_cli/plugins_dispatch.py"]
        tree = ast.parse(source)
        assignments = {}
        for node in tree.body:
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                if node.target.id in ("_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS", "_HOOK_TIMEOUT_BOUNDED_HOOKS", "_HOOK_CALLER_THREAD_HOOKS"):
                    assignments[node.target.id] = ast.literal_eval(node.value)
        namespace = self.common()
        namespace.update(assignments)
        namespace.update({"OBSERVER_SCHEMA_VERSION": "hermes.observer.v1", "_HOOK_SKIPPED": object(),
                          "_PRE_TOOL_CALL_TIMEOUT_BLOCK_MESSAGE": "bounded policy timeout",
                          "_CRON_HOOK_MAX_TIMEOUT": 30.0,
                          "_CRON_REQUIRED_BOUND_HOOKS": {"cron_execution_admission", "cron_execution_completed"}})
        functions(source, {"_hook_call_identity", "_hook_uses_callback_timeout", "_policy_error_block_directive",
                           "_cron_hook_timeout"}, namespace)
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                     and any(isinstance(child, ast.FunctionDef) and child.name == "invoke_hook" for child in node.body))
        method = next(node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name == "invoke_hook")
        method.name = "native_invoke_hook"
        exec(compile(ast.Module(body=[method], type_ignores=[]), "native-hook-dispatch", "exec"), namespace)
        self.module("hermes_cli.plugins", _resolve_hook_callback_timeout=lambda: 0.01)
        def allow(**_):
            return {"action": "allow"}
        def raises(**_):
            raise RuntimeError("synthetic admission callback error")
        def timeout(**_):
            self.fail("Native bounded callback seam returns skipped without running it")
        for callback in (raises, timeout):
            def bounded(_hook, cb, kwargs, _duration):
                return namespace["_HOOK_SKIPPED"] if cb is timeout else cb(**kwargs)
            manager = types.SimpleNamespace(_hooks={"cron_execution_admission": [allow, callback]},
                    _run_hook_callback_bounded=bounded, _report_hook_failure=lambda *_: None)
            results = namespace["native_invoke_hook"](manager, "cron_execution_admission", execution_id="exact-execution")
            self.assertEqual(results[0], {"action": "allow"})
            self.assertEqual(results[1]["action"], "block")
        self.assertEqual(namespace["_hook_call_identity"]({"execution_id": "exact-execution"}), "exact-execution")
        self.assertTrue(namespace["_hook_uses_callback_timeout"]("cron_execution_completed", 0.01))

    def test_hostile_disabled_timeout_is_forced_in_real_sync_and_async_dispatch(self):
        source = self.native["hermes_cli/plugins_dispatch.py"]
        tree = ast.parse(source)
        namespace = self.common()
        namespace.update({"OBSERVER_SCHEMA_VERSION": "hermes.observer.v1", "_HOOK_SKIPPED": object(),
            "_PRE_TOOL_CALL_TIMEOUT_BLOCK_MESSAGE": "bounded policy timeout", "_CRON_HOOK_MAX_TIMEOUT": 30.0,
            "_CRON_REQUIRED_BOUND_HOOKS": {"cron_execution_admission", "cron_execution_completed"},
            "_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS": {"pre_tool_call", "cron_execution_admission"},
            "_HOOK_TIMEOUT_BOUNDED_HOOKS": {"cron_execution_admission", "cron_execution_completed"},
            "_HOOK_CALLER_THREAD_HOOKS": set(), "_HOOK_MAX_ABANDONED_WORKERS": 3,
            "threading": threading, "time": time, "contextvars": contextvars, "asyncio": asyncio,
            "inspect": inspect, "logger": types.SimpleNamespace(warning=lambda *_: None)})
        functions(source, {"_hook_call_identity", "_hook_uses_callback_timeout", "_policy_error_block_directive",
                           "_cron_hook_timeout"}, namespace)
        for configured in (0, -1, float("inf"), float("nan"), 100):
            self.assertEqual(namespace["_cron_hook_timeout"]("cron_execution_admission", configured), 30.0)
        self.assertEqual(namespace["_cron_hook_timeout"]("cron_execution_completed", 0.01), 0.01)
        self.assertEqual(namespace["_cron_hook_timeout"]("legacy-hook", 0), 0)
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "PluginDispatchMixin")
        selected = [node for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name in {"invoke_hook", "ainvoke_hook", "_run_hook_callback_bounded"}]
        for method in selected:
            method.name = "native" + method.name
        exec(compile(ast.Module(body=selected, type_ignores=[]), "native-real-bounded-dispatch", "exec"), namespace)
        self.module("hermes_cli.plugins", _resolve_hook_callback_timeout=lambda: 0)
        # The source's production cap is asserted above. Scale only the clock
        # constant so the real daemon/timeout/abandon mechanism runs quickly.
        namespace["_CRON_HOOK_MAX_TIMEOUT"] = 0.03
        for asynchronous in (False, True):
            release = threading.Event()
            callback_threads = []
            def blocked(**_):
                callback_threads.append(threading.get_ident())
                release.wait(2)
                return {"action": "allow"}
            manager = types.SimpleNamespace(_hooks={"cron_execution_admission": [blocked]},
                _hook_timeout_lock=threading.Lock(), _hook_timeout_suppressed_until={},
                _hook_running_callbacks={}, _hook_abandoned={}, _hook_timeout_suppression_seconds=0.1,
                _invoke_hook_callback=lambda callback, kwargs: callback(**kwargs),
                _report_hook_failure=lambda *_: None)
            manager._run_hook_callback_bounded = types.MethodType(namespace["native_run_hook_callback_bounded"], manager)
            start = time.monotonic()
            try:
                if asynchronous:
                    result = asyncio.run(namespace["nativeainvoke_hook"](manager, "cron_execution_admission", execution_id="execution"))
                else:
                    result = namespace["nativeinvoke_hook"](manager, "cron_execution_admission", execution_id="execution")
                self.assertLess(time.monotonic() - start, 1)
                self.assertEqual(result[0]["action"], "block")
                self.assertNotEqual(callback_threads[0], threading.get_ident())
            finally:
                release.set()

    def test_trusted_create_persists_local_delivery_and_immutable_admission(self):
        self.module("cron.lifecycle_guard", check_gateway_lifecycle=lambda *_: None)
        tree = ast.parse(self.native["cron/jobs.py"])
        normalizers = next(n for n in tree.body if isinstance(n, ast.AnnAssign)
                           and isinstance(n.target, ast.Name) and n.target.id == "_CREATE_FIELD_NORMALIZERS")
        keys = [ast.literal_eval(k) for k in normalizers.value.keys]
        stored = []
        ns = self.common()
        ns.update({"_CREATE_FIELD_NORMALIZERS": {k: lambda value: value for k in keys},
                   "parse_schedule": lambda _: {"kind": "interval", "display": "synthetic"},
                   "normalize_repeat_value": lambda value: value,
                   "_normalize_skill_list": lambda *_: [], "_normalize_reasoning_effort": lambda _: None,
                   "_validate_job_mode_invariants": lambda *_: None, "_coerce_job_text": lambda value: value or "",
                   "_next_run_or_reject_past_oneshot": lambda *_: "2026-10-04T21:00:00Z",
                   "_jobs_lock": contextlib.nullcontext, "load_jobs": lambda: [],
                   "save_jobs": lambda jobs: stored.extend(jobs),
                   "_IMMUTABLE_JOB_FIELDS": frozenset({"id", "required_admission", "admission_key"})})
        functions(self.native["cron/jobs.py"], {"create_job", "update_job"}, ns)
        result = ns["create_job"]("synthetic prompt", "every 1h", deliver="local", failure_deliver="local",
                                  paused=True, required_admission="neurobro", admission_key="logical-key")
        self.assertEqual(stored, [result])
        self.assertFalse(result["enabled"])
        for key, value in {"required_admission": "neurobro", "admission_key": "logical-key",
                           "deliver": "local", "failure_deliver": "local"}.items():
            self.assertEqual(result[key], value)
        for field in ("required_admission", "admission_key"):
            with self.assertRaises(ValueError):
                ns["update_job"](result["id"], {field: None})

    def output_writer(self):
        home = self.root / "home"
        ns = self.common()
        ns.update({"ensure_dirs": lambda: None, "_job_output_dir": lambda job: home / "cron/output" / job,
                   "_ensure_cron_dir": lambda path: path.mkdir(parents=True, exist_ok=True),
                   "_secure_dir": lambda _: None, "_secure_file": lambda _: None,
                   "atomic_write_text": lambda path, output, **_: path.write_text(output, encoding="utf-8"),
                   "_prune_job_output": lambda *_: None, "_cron_output_keep": lambda: 100})
        functions(self.native["cron/jobs.py"], {"save_job_output"}, ns)
        return home, ns

    def test_exact_execution_paths_cannot_collide_or_escape(self):
        _, ns = self.output_writer()
        first = ns["save_job_output"]("job", "first", execution_id="execution-a")
        second = ns["save_job_output"]("job", "second", execution_id="execution-b")
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_text(), "first")
        self.assertEqual(second.read_text(), "second")
        with self.assertRaises(ValueError):
            ns["save_job_output"]("job", "bad", execution_id="../escape")

    def ledger(self, home, callback):
        database = self.root / "executions.db"
        def connect():
            conn = sqlite3.connect(database)
            conn.row_factory = sqlite3.Row
            return conn
        def add_column(conn, table, column, definition):
            if column not in {row[1] for row in conn.execute("PRAGMA table_info(" + table + ")")}:
                conn.execute("ALTER TABLE " + table + " ADD COLUMN " + definition)
        @contextlib.contextmanager
        def transaction(conn):
            try:
                conn.execute("BEGIN IMMEDIATE")
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.close()
        self.module("hermes_cli.sqlite_util", add_column_if_missing=add_column, transaction=transaction)
        self.module("hermes_cli.plugins", invoke_hook=callback)
        ns = self.common()
        ns.update({"sqlite3": sqlite3, "_lock": threading.RLock(), "_connect": connect,
                   "get_hermes_home": lambda: home, "_PROCESS_ID": "process",
                   "_prune_unlocked": lambda _: None, "_emit_execution_state": lambda *_, **__: None,
                   "record_cron_finish": lambda *_: None})
        functions(self.native["cron/executions.py"], {"_initialize_schema", "_transaction", "_fetch",
                  "_emit_execution_completion", "_validate_execution_output", "finish_execution", "get_execution"}, ns)
        with contextlib.closing(connect()) as conn:
            with conn:
                ns["_initialize_schema"](conn)
                for execution in ("execution-a", "execution-b"):
                    conn.execute("INSERT INTO executions(id,job_id,source,process_id,pid,status,claimed_at) VALUES(?,?,?,?,?,?,?)",
                                 (execution, "job", "synthetic", "process", os.getpid(), "running", "2026-10-04T20:00:00Z"))
        return ns

    def test_native_terminal_cas_persists_exact_manifest_before_observer(self):
        home, writer = self.output_writer()
        output = writer["save_job_output"]("job", "exact output bytes", execution_id="execution-a")
        observed = []
        ledger = None
        def observe(hook, **payload):
            # Independent DB connection already sees the committed terminal row.
            observed.append((hook, payload, ledger["get_execution"](payload["execution_id"])))
            return []
        ledger = self.ledger(home, observe)
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        row = ledger["finish_execution"]("execution-a", success=True, output_file=str(output.resolve()), output_sha256=digest)
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["output_file"], str(output.resolve()))
        self.assertEqual(row["output_sha256"], digest)
        self.assertEqual(observed[0][0], "cron_execution_completed")
        self.assertEqual(observed[0][1]["task_id"], "cron:job:execution-a")
        self.assertEqual(observed[0][1]["outcome"], "completed")
        self.assertEqual(observed[0][2], row)
        self.assertIsNone(ledger["finish_execution"]("execution-a", success=False, error="late rewrite"))
        self.assertEqual(len(observed), 1)

    def test_callback_loss_cold_read_has_same_manifest_without_rerun(self):
        home, writer = self.output_writer()
        output = writer["save_job_output"]("job", "retained result", execution_id="execution-a")
        def lost(*_, **__):
            raise RuntimeError("synthetic callback loss after commit")
        ledger = self.ledger(home, lost)
        row = ledger["finish_execution"]("execution-a", success=True, output_file=str(output.resolve()),
                                         output_sha256=hashlib.sha256(output.read_bytes()).hexdigest())
        self.assertEqual(ledger["get_execution"]("execution-a"), row)
        self.assertEqual(output.read_text(), "retained result")

    def test_wrong_hash_outside_root_and_wrong_owner_never_publish(self):
        home, writer = self.output_writer()
        output = writer["save_job_output"]("job", "result", execution_id="execution-a")
        observed = []
        ledger = self.ledger(home, lambda *args, **kw: observed.append((args, kw)))
        with self.assertRaises(ValueError):
            ledger["finish_execution"]("execution-a", success=True, output_file=str(output.resolve()), output_sha256="0" * 64)
        outside = self.root / "outside.txt"
        outside.write_text("outside")
        with self.assertRaises(ValueError):
            ledger["finish_execution"]("execution-a", success=True, output_file=str(outside),
                                        output_sha256=hashlib.sha256(outside.read_bytes()).hexdigest())
        ledger["_PROCESS_ID"] = "other-owner"
        self.assertIsNone(ledger["finish_execution"]("execution-a", success=True))
        self.assertEqual(ledger["get_execution"]("execution-a")["status"], "running")
        self.assertEqual(observed, [])

    def test_native_save_to_finish_call_chain_connected(self):
        home, writer = self.output_writer()
        ledger = self.ledger(home, lambda *_, **__: [])
        self.module("cron.unreachable_retry", is_retry_run=lambda _: False)
        namespace = self.common()
        namespace.update({"dataclass": dataclasses.dataclass, "save_job_output": writer["save_job_output"],
            "self_removal_delivery_allowed": lambda _: False, "mark_job_run": lambda *_, **__: True,
            "_is_interrupted": lambda *_: False, "_compose_run_delivery": lambda *_, **__: ("", False, False, False, None),
            "_classify_delivery_outcome": lambda **_: "local", "_normalize_deliver_value": lambda value: value,
            "_delivery_lane_value": lambda *_, **__: "local", "finish_execution": ledger["finish_execution"],
            "_FireOwnership": object})
        functions(self.native["cron/scheduler.py"], {"_RunDelivery", "_save_compose_deliver", "_finish_completed_run"}, namespace)
        fence = types.SimpleNamespace(side_effect_fence=lambda: contextlib.nullcontext(True))
        delivery = namespace["_RunDelivery"](job={"id": "job"}, success=True, error=None)
        namespace["_save_compose_deliver"](delivery, fence, "final", "source output", adapters=None, loop=None,
                                             verbose=False, execution_token=None, execution_id="execution-a")
        namespace["_finish_completed_run"](delivery, None, "execution-a")
        row = ledger["get_execution"]("execution-a")
        self.assertEqual(row["status"], "completed")
        self.assertEqual(Path(row["output_file"]).read_text(), "source output")
        self.assertEqual(row["output_sha256"], hashlib.sha256(b"source output").hexdigest())


if __name__ == "__main__":
    unittest.main()
