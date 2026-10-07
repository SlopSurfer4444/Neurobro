# Trusted Hermes broker bridge

This is a general Hermes plugin for source pin
`8d5e3e412138342e8bf30443e72bd4e6a9abd057`. It registers one tool,
`neurobro_tool({name, args})`. Neither its schema nor its return value carries
the broker credential. The broker validates the current task, grant, revision
and resource scope on every tool call.

The supported identity seam is the tool handler's injected `task_id` keyword.
Pinned native code builds this keyword independently of model arguments:

- [`api_server_runs.py`](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/gateway/platforms/api_server_runs.py) sets `effective_task_id = session_id or run.run_id` and passes it to `run_conversation`.
- [`model_tools.py`](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/model_tools.py) constructs trusted `dispatch_kwargs` from runtime IDs.
- [`tools/registry.py`](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/tools/registry.py) signature-filters those kwargs and passes them separately to the plugin handler.

No behavior-changing middleware is needed. Missing runtime context defaults to
`trusted_run_context_unavailable`; another tool middleware failing open cannot
create authority inside this handler.

## Host wiring

Use the entire `tools/hermes` directory as the plugin directory under an
isolated, explicitly chosen Hermes home and enable it through the supported
plugin configuration. This source change does not install or enable it.
Pinned proof covers `plugins.isolation: in_process` (the native default);
plugin-host mode has not been accepted by this probe. Use a dedicated single
profile process. Native sessions, runs and transcripts remain Hermes-owned.

Trusted launch configuration must provide all three values, or leave all three
unset (in which case the tool is unavailable):

```
NEUROBRO_BRIDGE_BIND=127.0.0.1:<explicit registration port>
NEUROBRO_BRIDGE_REGISTRATION_KEY=<separate registration-only key, at least 32 characters>
NEUROBRO_BROKER_URL=http://127.0.0.1:<broker port>/tools/call
```

The registration key authenticates only the plugin's loopback `/ready` and
`/bindings` endpoints. There is no management tool execution endpoint. It is
not a broker master credential. Calls to `/tools/call` use only the scoped
credential from the specific immutable admission binding.

Before native run creation, the host POSTs `/bindings` with Bearer registration
key and exact JSON fields `session_id`, `idempotency_key`, `tool_context`.
Response is `{ok:true,session_id}`. Exact repeats succeed; changing the key or
credential for an existing session returns 409. The host must use a fresh
native session for each admission/revision. Native session fork can preserve
transcript continuity only after the previous executor's settlement is proven;
the plugin does not perform that lifecycle operation.

`GET /ready`, with the same host authentication, returns the source pin,
`trustedIdentity: native_handler_task_id`, and
`requiresUniqueAdmissionSession: true`. This is plugin liveness/configuration,
not provider or broker readiness. The host must check the broker separately.

Bindings are deliberately process-local. After restart the host re-registers
the exact prior binding from its encrypted scoped-credential registry before
using the same run/session. Missing binding denies. No fallback credential,
latest-session credential, automatic retry, context supplied in a prompt, or
second scheduler is used.

Model-accessible shell/code must be disabled or isolated from the plugin host's
environment and memory. A fully privileged same-user terminal could read any
in-process credential, so this plugin alone cannot sandbox that terminal.
Grant expiry and revocation are enforced again in the broker before effects.

## Cron result boundary

`cron_result(job_id, execution_id)` explicitly returns
`cron_execution_output_binding_unavailable`. The pinned supported hook set
contains no cron completion observer. `cron.executions.finish_execution`
records the engine-owned execution ID and outcome but no output path/hash;
`cron.jobs.save_job_output(job_id, output)` writes a timestamp-named file;
the scheduler's `_save_compose_deliver` keeps that path local without publishing
an execution-bound plugin callback.

The bridge does not inspect private database rows, monkeypatch scheduler
functions, choose the newest file, or invent a correlated manifest. A supported
generic native completion hook carrying execution ID, outcome, exact output
path and hash/readback is required before this result channel can be accepted.
Native `cron.jobs.create_job` supports explicit `deliver=local` and
`failure_deliver=local`, but this by itself does not supply that result hook.
Sources:
[execution ledger](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/cron/executions.py),
[output writer](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/cron/jobs.py),
[scheduler](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/cron/scheduler.py),
[supported hooks](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/hermes_cli/plugins.py).

## Offline verification

Run `python test/hermes/bridge_test.py -v` from `packages/personal-agent`.
For the native-source proof set `NEUROBRO_HERMES_SOURCE` to a task-local source
directory containing the seven pinned native files named in `NativeSourceTests`
(paths flattened with underscores; `api_server_runs.py` is the exception).
The test verifies Git blob hashes before executing the actual native registry
dispatch AST and checking the connected runtime identity and cron boundaries.
Synthetic broker/management servers only listen on ephemeral numeric loopback
ports. No model, Telegram, provider or real credentials are used.
