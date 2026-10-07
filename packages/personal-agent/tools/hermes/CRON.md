# Native Hermes cron bridge

The recurring implementation keeps Hermes as the only scheduler. It adds a
versioned source patch, a trusted plugin control plane and a broker coordinator;
none of these contains a second due-time timer or foreground model loop.

The source patch is for official Hermes commit
`8d5e3e412138342e8bf30443e72bd4e6a9abd057` only. The builder verifies the
official Git blob identities before producing an overlay and receipt. A stock
engine does not provide this protocol; applying the reviewed patch to a fresh
isolated pinned checkout remains an operator-owned step. No existing profile,
installed pilot, provider authentication or live scheduler was changed here.

## Trust and lifecycle

The host creates an immutable schedule scope in its encrypted core store. Its
opaque credential authorizes only that schedule's admission/completion route;
it cannot call generic tools. `CronExtension` keeps only a credential digest
and native job pointer on disk. The credential itself is registered in memory
and restored by the host after restart. An unrestored scope denies execution.

Native creation is paused first. `required_admission=neurobro` and the trusted
`admission_key` are persisted separately from model prompts. The extension
stores the exact native job ID before enabling it. A lost creation response is
reconciled using that exact marker; zero or several candidates remain unknown
or conflicting. Replaying creation does not resume an owner-paused schedule.

Before native scripts, monitors or a model turn, the patched required admission
hook calls `/schedules/admit` with the engine-owned job and execution IDs.
The broker checks current task/grant revisions, expiry and revocation, then
issues a fresh tool context for `cron:<job>:<execution>`. The plugin binds that
runtime identity independently of model arguments. The original foreground
task/run/output stays separate from recurring execution records.

Pause/cancel blocks new admissions locally before native control dispatch and
revokes previously issued execution tokens. Native pause does not prove that
an already running worker stopped; status reports that active executions may
remain. An expired/revoked grant is never silently renewed by the schedule.

Native output uses the execution ID, not a timestamp, as its filename. Terminal
CAS stores status, exact absolute output path and SHA-256 together in the native
execution ledger. The completion hook is an observer after that commit. Hook
failure leaves the exact row available for reconciliation through native
`get_execution(execution_id)`; no newest-file or mtime inference is used.
The plugin verifies path containment and bytes again before publishing the
manifest. The broker fetches and compares this manifest before accepting it.
Unknown native outcomes are recorded without a delivery callback. An ambiguous
completion callback remains separately unknown and is not automatically retried.

## Explicit wiring

Use the ordinary trusted bridge configuration from [README.md](README.md), plus
`NEUROBRO_CRON_BIND=127.0.0.1:<dedicated-control-port>`. The trusted plugin
bootstrap calls `cron_extension.bootstrap(ctx, bridge)` once after configuring
the bridge. It requires native cron protocol version 1 from the reviewed patch.
The cron management endpoint uses the separate host registration key; no
registration credential is accepted at the generic tool endpoint.

The host supplies `HermesScheduleCoordinator` with the encrypted store and
callbacks for scope validation, context issue, context resolve and context
revocation. Its `/schedules/admit` and `/schedules/complete` handlers share the
broker's numeric loopback server. `createScheduleTools` exposes create, list,
inspect, pause, resume and cancel through normal capability/resource checks.
`restoreBindings()` runs before schedules are accepted after host restart.
Prepared records without a confirmed native ID remain preserved and denied;
they do not block startup by attempting an absent native binding. Trusted
host withdrawal can reconcile their immutable key through read-only lookup,
then cancel the exact discovered job without creating or resuming it.
Known job binding failures are isolated per schedule, durably marked unknown
and denied fresh admission. Healthy schedules continue restoration and the
host receives restored/degraded/skipped counts. Restoration uses at most four
concurrent calls under one 15-second startup deadline; remaining scopes stay
degraded until explicit later restoration, without creating jobs.

The prepared Windows profile uses native in-process cron execution. At this
pin, `tools.process_registry.restart_safe_gateway_child_argv()` returns
`in_process` before the systemd checks on non-Linux hosts. The plugin therefore
shares the gateway's trusted bridge and schedule registrations. A gateway
restart loses those memory bindings; fresh executions deny until host
`restoreBindings()` succeeds. A previously interrupted native execution is
never recreated by this bridge.

Managed Linux systemd detached cron workers are not accepted by this plugin
bootstrap yet: native worker discovery would inherit the gateway's control
ports. Do not enable that topology with this bootstrap until a separate,
authenticated worker admission/registration protocol is reviewed. This does
not change the five-file native overlay or enable a second scheduler.

For continuous monitors the host owns the subscription and pending candidate
ledger. Native cron supplies new execution IDs; the scoped model reads
`context.current`, collects new observations and records a semantic verdict.
Private alert delivery uses that verdict and durable effect reconciliation.
The host must suppress ordinary scheduled-result delivery for monitor
executions, so unchanged cycles remain quiet. The cron completion hook is
evidence of native completion, not by itself a matching-post verdict.

Cron control API:

- `GET /cron/ready`
- `POST /cron/jobs` with key, name, schedule, instruction and schedule_context
- `POST /cron/bindings` with key and schedule_context
- `GET /cron/jobs/<native-job-id>`
- `GET /cron/lookup/<immutable-admission-key>` (read-only exact reconciliation)
- `POST /cron/jobs/<native-job-id>/pause|resume|cancel`
- `GET /cron/results/<native-job-id>/<execution-id>`

All control calls require the registration-only Bearer key. Scope credentials
are used only on the broker admission/completion routes. All HTTP waits and
native new-hook callbacks are bounded; disabling ordinary plugin callback
timeouts does not disable the patched admission gate's finite timeout.
Broker tool waits default to 60 seconds, with a finite 600-second default for
`monitors.subscribe` and `monitors.collect` because source baselines can span
several reads, and 180 seconds for `images.generate`. A configured timeout overrides those defaults. Expired waits
remain UNKNOWN without transport retries. Native management does not hold its
lock over broker admission waits and rejects late grants after any control
transition, including pause followed by resume. Control acknowledgments require
readback of the exact native job state or its absence.

## Offline verification

`cron_extension_test.py` checks paused creation, exact uncertain-create
reconciliation, fresh scope admission, restart restoration, grant refusal,
scope drift, hash readback and the cross-thread completion readback path.
`schedules.test.ts` uses the actual encrypted core store and loopback HTTP;
it verifies expiry/revocation/revisions, context replay, control uncertainty,
foreground isolation and completion uncertainty. `cron_patch_test.py` verifies
official source hashes and executes patched native functions and SQLite CAS.

`native_cron_lifecycle_test.py`, when supplied `NEUROBRO_HERMES_RUNTIME` and
run by that runtime's venv Python, imports the reviewed overlay with the real
native job store, scheduler tick, claims, execution ledger and plugin dispatch.
Its synthetic pre-agent executor checks scoped collection, exact output/hash,
an early/unchanged tick, denied execution after plugin state loss, fresh
scope restoration, revoked authority and native cancellation. The fixture
clock advances to native-computed `next_run_at`; it does not use run-now or
manual collection to schedule an occurrence. Outbound sockets are prohibited;
no provider, authentication or Telegram adapter is used.
If the runtime checkout is already patched, `NEUROBRO_HERMES_PRISTINE_SOURCE`
can supply the separately verified five-file pristine root to the builder;
the same exact Git blob gates remain required and the runtime is never edited.

These checks establish source and isolated fixture behavior. A real pinned
Hermes process with this patch, an explicit provider, the installed plugin and
the broker is still a separate runtime acceptance gate.
