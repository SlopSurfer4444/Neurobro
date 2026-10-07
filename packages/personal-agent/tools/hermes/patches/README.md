# Versioned pinned native cron seam

`build_cron_patch.py` verifies every affected official Git blob at
Hermes `8d5e3e412138342e8bf30443e72bd4e6a9abd057` before any output is written.
It emits a fresh five-file overlay, unified diff and a receipt containing
source Git blob IDs and patched SHA256 hashes. It never modifies the original
checkout or installs/enables a runtime. `native-overlay-v2-final` is the generated
reviewable artifact. `LICENSE.Hermes` preserves upstream MIT licensing.

```
python tools/hermes/patches/build_cron_patch.py \
  --source-root <exact pinned source checkout> \
  --destination-root <fresh overlay directory>
```

The overlay is a source delta, not a complete runnable Hermes distribution.
Apply its five files to an isolated checkout of that exact pin after reviewing
the diff and receipt. No stock release compatibility or deployed acceptance is
claimed. `NEUROBRO_CRON_PROTOCOL_VERSION = 1` appears in `cron.jobs`,
`cron.scheduler` and `cron.executions` for explicit runtime feature detection.
All three also expose `NEUROBRO_CRON_PATCH_ID` equal to
`neurobro-hermes-cron-bridge-v2` and `NEUROBRO_CRON_SOURCE_PIN` equal to the exact
Hermes pin. The extension must require these exact markers, since interface
version alone would also admit the historical v1 timeout gap. The earlier
`native-overlay-v2` candidate has the timeout repair but lacks these explicit
version markers; it is retained as historical and is not the final consumer.

The patch adds these generic supported seams:

- `cron.jobs.create_job(..., required_admission=None, admission_key=None)`
  persists optional trusted namespace/logical key metadata. Both fields are
  immutable through `update_job`. Model-facing native tool/HTTP schemas are
  unchanged and do not expose these creation fields.
- Before `run_job` executes any script, monitor or model, explicitly tagged jobs
  require `cron_execution_admission` to return a nonempty set of explicit allow
  results. Missing execution ID, missing hook, malformed/refused result,
  callback exception and timeout deny. Untagged jobs retain native behavior.
  Payload fields are `job_id`, `execution_id`, `task_id`, `admission_namespace`
  and `admission_key`. The task ID is exactly `cron:<job_id>:<execution_id>`,
  matching the existing native `_CronRunScope` identity. Credentials are never
  returned to native job/model JSON; the trusted plugin binds a fresh scoped
  credential before returning allow.
- Both new hooks use native bounded dispatch. Admission additionally belongs
  to native fail-closed policy hooks. Thus an allow from one handler does not
  override another handler's error/timeout block. Execution ID participates in
  native callback identity/custody. Both new hooks force a finite maximum of
  30 seconds even when the general hook timeout is zero, infinite or NaN. A
  smaller positive configured bound is honored. Their async dispatch also uses
  native bounded daemon callback custody; sync callbacks cannot stall the event
  loop inline. Other hook behavior remains unchanged. `native-overlay-v1` is
  preserved as a historical generation without this forced-timeout repair.
- `save_job_output(..., execution_id=...)` writes an execution-specific filename
  instead of a timestamp filename for scheduler executions. Distinct executions
  within the same second cannot overwrite each other. Legacy callers without an
  execution ID retain the timestamp path.
- `_save_compose_deliver` retains the exact canonical path and content SHA256.
  `finish_execution(..., output_file=None, output_sha256=None)` validates file
  existence, native output-root containment and byte hash, then persists both
  fields in the same native SQLite transaction/CAS as terminal status. Wrong
  owner and already terminal rows cannot be rewritten.
- Only after that CAS commits, `cron_execution_completed` observes `job_id`,
  `execution_id`, `task_id`, `outcome`, `output_file`, `output_sha256`, `error`.
  It is an observer and has no admission authority. Some failed executions have
  no output file; null fields are honest absence. Callback loss/timeout does not
  undo completion. The supported patched `get_execution(execution_id)` returns
  the exact persisted receipt after process restart without rerunning anything.

The native execution ledger is the durable result manifest. A crash after
output save but before the terminal ledger transaction produces no completed
manifest: normal native owner reconciliation remains authoritative. A crash
after terminal commit but before observer delivery is recoverable by exact
execution ID. Artifact readback must still check the path and hash; native
output pruning, deletion or later modification can make bytes unavailable and
must not trigger another model run.

This patch adds no scheduler, no private database writer, no newest-file scan
and no monkeypatch. Fresh grant admission and delivery receipts remain in the
broker/plugin extension. The model's terminal/tool isolation remains a separate
host enforcement requirement.

Offline validation: `python test/hermes/cron_patch_test.py -v` with
`NEUROBRO_HERMES_SOURCE` pointing at the flattened exact source packet described
in the test. Tests compile/exercise the actual patched native functions,
required gate ordering, native policy dispatcher, output writer, connected
save-to-finish flow and real SQLite commit/CAS/readback. Provider, Telegram and
model runtimes are replaced only at external seams; no live request occurs.
