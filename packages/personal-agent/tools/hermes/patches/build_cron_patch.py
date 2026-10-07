"""Build a versioned overlay from exact official Hermes Git blobs.

Source is never modified. The fresh destination contains five patched native
files, a reviewable unified diff and a hash-bound receipt. Apply the overlay
only to the same pinned native checkout; this script does not install Hermes.
"""
from __future__ import annotations

import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path

PIN = "8d5e3e412138342e8bf30443e72bd4e6a9abd057"
PATCH_ID = "neurobro-hermes-cron-bridge-v2"
BLOBS = {
    "cron/jobs.py": "2e421c7af328f7e9e259713e03c8880e35ccf793",
    "cron/scheduler.py": "4082d766f35ccf9b546654fae8ba8dba4d563747",
    "cron/executions.py": "b6afa0d3797975cb1d5a5c6e7be45e8b9aea4006",
    "hermes_cli/plugins.py": "4fbf7394c85980177b2e3139526bfa4fd45d58cc",
    "hermes_cli/plugins_dispatch.py": "78c3927fc4fc39d2ae523749238e110504fefe47",
}


class SourceMismatch(ValueError):
    pass


def replace_once(source: str, before: str, after: str) -> str:
    if source.count(before) != 1:
        raise SourceMismatch("Pinned patch context must occur exactly once")
    return source.replace(before, after, 1)


def transform_jobs(source: str) -> str:
    source = replace_once(source, "import contextlib\n", f"NEUROBRO_CRON_PROTOCOL_VERSION = 1\nNEUROBRO_CRON_PATCH_ID = {PATCH_ID!r}\nNEUROBRO_CRON_SOURCE_PIN = {PIN!r}\n\nimport contextlib\n")
    source = replace_once(source, '_IMMUTABLE_JOB_FIELDS = frozenset({"id"})',
                          '_IMMUTABLE_JOB_FIELDS = frozenset({"id", "required_admission", "admission_key"})')
    source = replace_once(source, '    interpreter: Optional[str] = None,\n) -> Dict[str, Any]:\n    """Create a new cron job',
                          '    interpreter: Optional[str] = None,\n    required_admission: Optional[str] = None,\n    admission_key: Optional[str] = None,\n) -> Dict[str, Any]:\n    """Create a new cron job')
    source = replace_once(source, '    if not isinstance(paused, bool):\n', '''    # Trusted host binding metadata; model-facing cron HTTP/tool schemas do not
    # expose these fields. They are immutable after creation.
    if required_admission is not None and (
        not isinstance(required_admission, str)
        or re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", required_admission) is None
    ):
        raise ValueError("Invalid required cron admission namespace")
    if admission_key is not None and (
        not isinstance(admission_key, str) or not admission_key or len(admission_key) > 512
    ):
        raise ValueError("Invalid trusted cron admission key")
    if not isinstance(paused, bool):
''')
    source = replace_once(source, '        ("failure_deliver", f["failure_deliver"]), ("interpreter", f["interpreter"]),\n',
                          '        ("failure_deliver", f["failure_deliver"]), ("interpreter", f["interpreter"]),\n        ("required_admission", required_admission), ("admission_key", admission_key),\n')
    source = replace_once(source, 'def save_job_output(job_id: str, output: str):',
                          'def save_job_output(job_id: str, output: str, *, execution_id: Optional[str] = None):')
    source = replace_once(source, '    output_file = job_output_dir / f"{_hermes_now().strftime(\'%Y-%m-%d_%H-%M-%S\')}.md"\n', '''    if execution_id is not None:
        if not isinstance(execution_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", execution_id) is None:
            raise ValueError("Invalid cron execution output identity")
        # Native owner ID, not timestamps or model filenames. Separate fires
        # cannot overwrite one another's result inside the same second.
        output_file = job_output_dir / f"execution-{execution_id}.md"
    else:
        output_file = job_output_dir / f"{_hermes_now().strftime('%Y-%m-%d_%H-%M-%S')}.md"
''')
    return source


ADMISSION_HELPER = '''def _require_cron_execution_admission(job: dict, execution_id: Optional[str]) -> Optional[str]:
    """Required execution gate for explicitly tagged jobs, before any script/model.

    This is an authority hook, not an observer. No result, an exception, any
    refusal or a malformed result denies. Credentials stay in the trusted
    plugin/broker; the native engine only receives an explicit admission fact.
    """
    namespace = job.get("required_admission")
    if namespace is None:
        return None
    if (not isinstance(namespace, str)
            or re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", namespace) is None
            or not isinstance(execution_id, str) or not execution_id):
        return "required_cron_execution_admission_unavailable"
    try:
        from hermes_cli.plugins import invoke_hook
        results = invoke_hook(
            "cron_execution_admission", job_id=job["id"], execution_id=execution_id,
            task_id=f"cron:{job['id']}:{execution_id}", admission_namespace=namespace,
            admission_key=job.get("admission_key"),
        )
    except Exception:
        return "required_cron_execution_admission_unavailable"
    if (not isinstance(results, list) or not results
            or any(not isinstance(result, dict) or result.get("action") != "allow" for result in results)):
        return "required_cron_execution_admission_refused"
    return None


'''


def transform_scheduler(source: str) -> str:
    source = replace_once(source, "import atexit\n", f"NEUROBRO_CRON_PROTOCOL_VERSION = 1\nNEUROBRO_CRON_PATCH_ID = {PATCH_ID!r}\nNEUROBRO_CRON_SOURCE_PIN = {PIN!r}\n\nimport atexit\nimport hashlib\n")
    source = replace_once(source, "def run_job(\n", ADMISSION_HELPER + "def run_job(\n")
    source = replace_once(source, '    early, prompt = _prepare_job_prompt(job, job_id, job_name, extra_prompt, cancel_event)\n', '''    admission_error = _require_cron_execution_admission(job, execution_id)
    if admission_error is not None:
        return False, f"# Cron Job: {job_id}\\n\\nError: {admission_error}\\n", "", admission_error
    early, prompt = _prepare_job_prompt(job, job_id, job_name, extra_prompt, cancel_event)
''')
    source = replace_once(source, '    side_effect_ownership_lost: bool = False\n',
                          '    side_effect_ownership_lost: bool = False\n    output_file: Optional[str] = None\n    output_sha256: Optional[str] = None\n')
    source = replace_once(source, '    adapters, loop, verbose: bool, execution_token,\n) -> None:\n    """Save output',
                          '    adapters, loop, verbose: bool, execution_token, execution_id: Optional[str] = None,\n) -> None:\n    """Save output')
    source = replace_once(source, '            else save_job_output(job["id"], output))\n', '''            else save_job_output(job["id"], output, execution_id=execution_id))
        if output_file is not None:
            d.output_file = str(output_file.resolve(strict=True))
            d.output_sha256 = hashlib.sha256(output_file.read_bytes()).hexdigest()
''')
    source = replace_once(source, '                execution_token=execution_token)\n        except _FireClaimLostDuringSideEffect:',
                          '                execution_token=execution_token, execution_id=execution_id)\n        except _FireClaimLostDuringSideEffect:')
    source = replace_once(source, '        execution_id, success=d.success, error=d.error, delivery_outcome=delivery_outcome)\n',
                          '        execution_id, success=d.success, error=d.error, delivery_outcome=delivery_outcome,\n        output_file=d.output_file, output_sha256=d.output_sha256)\n')
    return source


COMPLETION_HELPER = '''def _emit_execution_completion(record: Optional[Dict[str, Any]]) -> None:
    """Observer after terminal CAS; durable row is the recovery authority.

    Callback loss cannot remove output correlation: get_execution(id) returns
    the same committed path/hash/outcome. This observer grants no capability.
    """
    if record is None or record.get("status") not in ("completed", "failed"):
        return
    try:
        from hermes_cli.plugins import invoke_hook
        invoke_hook(
            "cron_execution_completed", job_id=record["job_id"], execution_id=record["id"],
            task_id=f"cron:{record['job_id']}:{record['id']}", outcome=record["status"],
            output_file=record.get("output_file"), output_sha256=record.get("output_sha256"),
            error=record.get("error"),
        )
    except Exception:
        pass  # Observation must never rewrite or retry native execution state.


def _validate_execution_output(output_file: Optional[str], output_sha256: Optional[str]) -> tuple:
    if output_file is None and output_sha256 is None:
        return None, None
    if (not isinstance(output_file, str) or not isinstance(output_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", output_sha256) is None):
        raise ValueError("Incomplete cron output receipt")
    path = Path(output_file)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("Invalid cron output file")
    resolved = path.resolve(strict=True)
    root = get_hermes_home().resolve() / "cron" / "output"
    if not resolved.is_relative_to(root):
        raise ValueError("Cron output escaped native output root")
    digest = hashlib.sha256()
    with resolved.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    if digest.hexdigest() != output_sha256:
        raise ValueError("Cron output hash mismatch before terminal completion")
    return str(resolved), output_sha256


'''


def transform_executions(source: str) -> str:
    source = replace_once(source, "import math\n", f"NEUROBRO_CRON_PROTOCOL_VERSION = 1\nNEUROBRO_CRON_PATCH_ID = {PATCH_ID!r}\nNEUROBRO_CRON_SOURCE_PIN = {PIN!r}\n\nimport math\nimport hashlib\nimport re\n")
    source = replace_once(source, '    add_column_if_missing(conn, "executions", "delivery_outcome", "delivery_outcome TEXT")\n', '''    add_column_if_missing(conn, "executions", "delivery_outcome", "delivery_outcome TEXT")
    add_column_if_missing(conn, "executions", "output_file", "output_file TEXT")
    add_column_if_missing(conn, "executions", "output_sha256", "output_sha256 TEXT")
''')
    source = replace_once(source, 'def finish_execution(\n', COMPLETION_HELPER + 'def finish_execution(\n')
    source = replace_once(source, '    delivery_outcome: Optional[str] = None,\n) -> Optional[Dict[str, Any]]:\n    """Write a terminal result once;',
                          '    delivery_outcome: Optional[str] = None,\n    output_file: Optional[str] = None, output_sha256: Optional[str] = None,\n) -> Optional[Dict[str, Any]]:\n    """Write a terminal result once;')
    source = replace_once(source, '    """Write a terminal result once; terminal attempts cannot be rewritten."""\n    now = _hermes_now().isoformat()\n',
                          '    """Write a terminal result once; terminal attempts cannot be rewritten."""\n    output_file, output_sha256 = _validate_execution_output(output_file, output_sha256)\n    now = _hermes_now().isoformat()\n')
    source = replace_once(source, '                   handoff_started_at=NULL, delivery_outcome=?\n',
                          '                   handoff_started_at=NULL, delivery_outcome=?, output_file=?, output_sha256=?\n')
    source = replace_once(source, '            (status, now, detail, delivery_outcome, execution_id, _PROCESS_ID, os.getpid()),\n',
                          '            (status, now, detail, delivery_outcome, output_file, output_sha256,\n             execution_id, _PROCESS_ID, os.getpid()),\n')
    source = replace_once(source, '    record_cron_finish(record, delivery_outcome)\n    return record\n',
                          '    record_cron_finish(record, delivery_outcome)\n    _emit_execution_completion(record)\n    return record\n')
    return source


def transform_plugins(source: str) -> str:
    return replace_once(source, '    "pre_command",\n}', '''    "pre_command",
    # Generic cron integration: required admission is an authority gate for
    # explicitly tagged jobs; completion is observer-only after terminal CAS.
    "cron_execution_admission", "cron_execution_completed",
}''')


def transform_dispatch(source: str) -> str:
    source = replace_once(source, "import asyncio\n", "import asyncio\nimport math\n")
    source = replace_once(source,
        '    "pre_auxiliary_call", "post_auxiliary_call", "pre_verify", "on_session_start", "on_session_end",\n',
        '    "pre_auxiliary_call", "post_auxiliary_call", "pre_verify", "on_session_start", "on_session_end",\n    "cron_execution_admission", "cron_execution_completed",\n')
    source = replace_once(source,
        '_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS: Set[str] = {"pre_tool_call"}',
        '_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS: Set[str] = {"pre_tool_call", "cron_execution_admission"}')
    source = replace_once(source, '    for field in ("tool_call_id", "turn_id"):\n',
        '    for field in ("tool_call_id", "turn_id", "execution_id"):\n')
    source = replace_once(source, 'def _hook_uses_callback_timeout(hook_name: str, timeout: float) -> bool:\n', '''_CRON_HOOK_MAX_TIMEOUT = 30.0
_CRON_REQUIRED_BOUND_HOOKS = {"cron_execution_admission", "cron_execution_completed"}


def _cron_hook_timeout(hook_name: str, configured: float) -> float:
    if hook_name not in _CRON_REQUIRED_BOUND_HOOKS:
        return configured
    if not math.isfinite(configured) or configured <= 0:
        return _CRON_HOOK_MAX_TIMEOUT
    return min(configured, _CRON_HOOK_MAX_TIMEOUT)


def _hook_uses_callback_timeout(hook_name: str, timeout: float) -> bool:
''')
    timeout_context = '        timeout = _resolve_hook_callback_timeout()\n        use_timeout = _hook_uses_callback_timeout(hook_name, timeout)\n'
    if source.count(timeout_context) != 2:
        raise SourceMismatch("Expected both sync and async hook timeout contexts")
    source = source.replace(timeout_context,
        '        timeout = _cron_hook_timeout(hook_name, _resolve_hook_callback_timeout())\n        use_timeout = _hook_uses_callback_timeout(hook_name, timeout)\n')
    source = replace_once(source, '                ret = cb(**self._hook_callback_kwargs(cb, kwargs))\n                if inspect.isawaitable(ret):\n', '''                if hook_name in _CRON_REQUIRED_BOUND_HOOKS:
                    # Sync callbacks must not execute inline on the event loop.
                    # Use the native daemon/custody bound for both callback kinds;
                    # no cancellation-resistant callback can hold this path open.
                    ret = await asyncio.to_thread(
                        self._run_hook_callback_bounded, hook_name, cb, kwargs, timeout)
                    if ret is _HOOK_SKIPPED:
                        if fail_closed:
                            results.append({"action": "block", "message": _PRE_TOOL_CALL_TIMEOUT_BLOCK_MESSAGE})
                        continue
                else:
                    ret = cb(**self._hook_callback_kwargs(cb, kwargs))
                if inspect.isawaitable(ret):
''')
    return source


TRANSFORMS = {
    "cron/jobs.py": transform_jobs,
    "cron/scheduler.py": transform_scheduler,
    "cron/executions.py": transform_executions,
    "hermes_cli/plugins.py": transform_plugins,
    "hermes_cli/plugins_dispatch.py": transform_dispatch,
}


def plan(source_root: Path) -> dict:
    result = {}
    # Verify every exact blob before transforming or emitting any file.
    for path, expected in BLOBS.items():
        raw = (source_root / path).read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if actual != expected:
            raise SourceMismatch(f"Pinned Git blob mismatch: {path}")
        result[path] = {"before": raw.decode("utf-8"), "sourceBlob": actual}
    for path, item in result.items():
        item["after"] = TRANSFORMS[path](item["before"])
        # Every emitted Python file must parse and compile before any write.
        tree = ast.parse(item["after"], filename=path)
        compile(tree, path, "exec")
    return result


def build(source_root: Path, destination_root: Path) -> dict:
    source_root = source_root.resolve(strict=True)
    destination_root = destination_root.resolve()
    if destination_root.exists() or destination_root.is_relative_to(source_root):
        raise ValueError("Fresh separate overlay destination required")
    planned = plan(source_root)
    receipt = {"patchId": PATCH_ID, "hermesPin": PIN, "kind": "native-source-overlay", "files": {}}
    patches = []
    destination_root.mkdir(parents=True)
    for path, item in planned.items():
        target = destination_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = item["after"].encode("utf-8")
        target.write_bytes(raw)
        receipt["files"][path] = {"sourceBlob": item["sourceBlob"],
                                   "patchedSha256": hashlib.sha256(raw).hexdigest()}
        patches.extend(difflib.unified_diff(item["before"].splitlines(True), item["after"].splitlines(True),
                                           fromfile="a/" + path, tofile="b/" + path))
    (destination_root / (PATCH_ID + ".patch")).write_text("".join(patches), encoding="utf-8", newline="")
    # Receipt is last; absence means an incomplete build, never accepted.
    (destination_root / "patch-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--destination-root", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(build(arguments.source_root, arguments.destination_root), indent=2))
