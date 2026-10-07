# Personal-agent operations

This package is a new personal composition root. Preparation, doctor, launch-plan generation and backup are repository-local operations. They do not enable an old Neurobro task, borrow a Hermes profile, authorize Telegram, start Docker/WSL, register autostart, or send a message. Account onboarding and activation require the owner's separate live-operation instruction.

## Selected runtime

`tools/ops/runtime-manifest.json` pins Node 24.15.0, Python 3.14.4, Hermes source `8d5e3e412138342e8bf30443e72bd4e6a9abd057` and its exact `uv.lock` hash, and TDLib **1.8.67**, source `42e6a5259551178d1dab54a22ad96d14bd906e20` plus schema hash. TDLib's old v1.8.0 release is not the selected schema. A native binary is admitted by its own SHA256 and build provenance; the source version is not proof that an arbitrary DLL exports that ABI.

The engine is the pinned Python gateway process, with native sessions and Runs APIs. It is not the historical image pilot. An authenticated capabilities check must prove durable run idempotency before task admission. A restarted interrupted run stays a reconciliation anchor; use the original key and inspect its status. Creation under a new key is a new operation, not recovery.

Official source: [Hermes dependency lock](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/uv.lock), [API gateway](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/website/docs/user-guide/features/api-server.md), [TDLib version](https://github.com/tdlib/td/blob/42e6a5259551178d1dab54a22ad96d14bd906e20/CMakeLists.txt).

## Source/dependency preparation

Run from `packages/personal-agent`, with already approved absolute runtime paths. The included bootstrap is an **opt-in repo-local dependency** flow through Git and uv. It fetches exact source commits, verifies hashes before dependency sync, and runs `uv sync --locked --no-dev --extra web --extra mcp --extra cron` into the source's `.venv`. It refuses an existing `.runtime` destination, disables interactive Git auth, and prevents uv from downloading a new Python. It does not install global tooling or launch Hermes.

```powershell
npm ci --ignore-scripts
& ./tools/ops/bootstrap.ps1 -GitExe 'C:/PATH/git.exe' -UvExe 'C:/PATH/uv.exe' -PythonExe 'C:/PATH/python.exe' -FetchTdlib
```

Provide the declared Python 3.14.4, rather than permitting an implicit interpreter download. `.runtime` is generated deployment material and should be ignored by Git. Preserve failed preparation for diagnosis; do not silently reuse a half-built environment. Use a newly named staging directory/checkout for a new candidate generation.

TDLib build prerequisites are an operator/tool-adoption handoff if absent: an approved CMake executable, MSVC x64 toolchain, gperf and OpenSSL. No Windows feature, service or new compiler is installed by this package. Using the pinned checkout, a concrete Windows build is:

```powershell
& 'C:/PATH/cmake.exe' -S .runtime/tdlib -B .runtime/tdlib-build -A x64 -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR='C:/PATH/openssl' -DOPENSSL_USE_STATIC_LIBS=TRUE -DGPERF_EXECUTABLE='C:/PATH/gperf.exe'
& 'C:/PATH/cmake.exe' --build .runtime/tdlib-build --config Release --target tdjson
```

Record the compiler/dependency versions and hashes with the produced `tdjson.dll`; keep any required native dependency DLLs inside the isolated runtime payload, never on global PATH. `examples/runtime-bindings.json` records actual executable/DLL paths and hashes. Its placeholders intentionally fail validation. `--expected-sha256` on `tools/tdlib_sidecar.py` must match the same binary. The sidecar's `--doctor` checks file binding without loading it; it reports that native ABI is unverified. The authorized native onboarding must separately verify `getOption(version)` and the actual JSON lifecycle.

## Fresh state and engine profile

Choose one new absolute state directory, outside old `.hermes`, `.codex`, Telegram session and Neurobro app directories. No old config, database, keys or memories are copied. Example preparation:

```powershell
node tools/ops/cli.ts prepare --state 'C:/PATH/TO/PRIVATE/STATE' --profile-id owner-personal-v1
node tools/ops/cli.ts prepare-engine --state 'C:/PATH/TO/PRIVATE/STATE' --plugin 'C:/PATH/REPO/packages/personal-agent/tools/hermes' --provider 'OWNER_SELECTED_PROVIDER' --model 'OWNER_SELECTED_MODEL'
```

Use the provider's actual lowercase supported identifier. `auto` is rejected. The fresh engine configuration enables the trusted bridge in `in_process` mode and sets **only** `platform_toolsets.api_server: [neurobro]`. Shell, unrestricted file/code tools, native messaging and model-facing native cron tools are not exposed. The broker remains the sole external-effect authority. Only the plugin's top-level Python/YAML files are placed in the profile; patch builders/overlays stay outside that loaded plugin. A file-hash receipt records the scoped copy. [Supported plugin discovery/configuration](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/website/docs/user-guide/features/plugins.md).

Preparation creates `.neurobro-profile.json`, separate `engine/home`, Telegram database/files, workspaces, artifacts, logs and temp directories, and leaves `STOP`. Unix mode bits are best effort on Windows; configure the actual deployment principal and Windows ACLs before custody of real credentials. An isolated directory/minimal environment does not establish an OS sandbox against a same-user shell.

Copy `examples/personal-agent.json` to a local deployment config and replace its placeholders. Keep identifiers as decimal strings. The owner's account, sender identity and exact private control destination are three explicit bindings; sample `0` values are invalid. Source scopes and computer execution begin empty/disabled. Database/files must match the profile paths. The example binds `hermes.bridgeUrl` to port 8788, `hermes.registrationKeyEnv` to `NEUROBRO_BRIDGE_REGISTRATION_KEY`, and `tools.port` to broker port 8787; these also match the application defaults. Set `artifacts.pythonExecutable` to an approved absolute Python interpreter with the required document-processing dependencies. Existence of that interpreter alone does not prove PDF/image/document processing readiness.

Required broker secrets are referenced by environment **names**, never literal JSON values: `NEUROBRO_STATE_KEY`, `NEUROBRO_HERMES_API_KEY`, `NEUROBRO_TG_API_ID`, `NEUROBRO_TG_API_HASH`. Use fresh owner-provided values through the trusted credential provisioner. Do not put values in argv, shell history, config examples or reports. The provider gets its own explicit credential, mapped from a `NEUROBRO_PROVIDER_*` name. A bridge registration key is a separate secret, at least 32 characters. Engine environment assembly clears inherited variables, substitutes the new home, and supplies no Telegram/account/session keys. Profile separation does not authorize borrowing another CLI's login.

Images are optional. The supported configuration is `images: {baseUrl: <HTTPS provider endpoint>, apiKeyEnv: <environment name>, model: <explicit model ID>}`. Provision an independently authorized image-provider API credential/allowance, such as `NEUROBRO_IMAGES_API_KEY`; a ChatGPT sign-in/subscription or availability of Codex's own image tool does not supply this service's API credential. Configured `images.apiKeyEnv` and `web.apiKeyEnv` are included only in the broker launch environment. Use separate environment names from the state, Telegram, engine API, bridge and engine-provider credentials; launch-plan generation rejects those aliases. They are not copied to Hermes. Telegram and artifact subprocesses must receive their own narrow runtime environments rather than inherit the broker's complete environment. Optional providers remain absent from the default example and require their own authenticated acceptance.

```powershell
node tools/ops/cli.ts doctor --config 'C:/PATH/personal-agent.json' --runtime 'C:/PATH/runtime-bindings.json' --probe-versions true
```

Doctor prints bounded check IDs/status/error codes. It does not print config, environment values, raw exceptions or API bodies. Default doctor performs no authentication/network/model request and does not execute runtime binaries. The explicit version option only runs hash-bound Node/Python `--version` with a minimal environment. Hashes and declared versions, native ABI, owner identity, provider readiness, durable engine handshake and OS containment are distinct evidence. Offline doctor always reports `liveReady: false`; pending live checks are not a deployed acceptance.

## Optional native cron overlay

Cron is disabled when `hermes.cronUrl` is absent. When explicitly enabled, use `http://127.0.0.1:8789`, separate from engine API 8642, bridge 8788 and broker 8787. The accepted extension requires the reviewed **`native-overlay-v2-final`**, patch ID `neurobro-hermes-cron-bridge-v2`, protocol version 1 and exact Hermes source pin. Neither stock Hermes nor an earlier overlay is accepted by this configuration. [Patch builder/apply contract](../tools/hermes/patches/README.md).

Prepare a fresh isolated pinned checkout through the bootstrap first. Before any gateway starts, build a new overlay from its original files:

```powershell
python tools/hermes/patches/build_cron_patch.py --source-root 'C:/PATH/REPO/packages/personal-agent/.runtime/hermes-agent' --destination-root 'C:/PATH/NEW/REVIEWED-OVERLAY'
```

Review that overlay's diff and receipt against `tools/hermes/patches/native-overlay-v2-final`; the builder verifies original Git blob identities before producing output. Check the isolated checkout's HEAD is exactly `8d5e3e412138342e8bf30443e72bd4e6a9abd057` and that its five destination files still match the original pin. After explicit source-patch acceptance, copy only `cron/jobs.py`, `cron/scheduler.py`, `cron/executions.py`, `hermes_cli/plugins.py` and `hermes_cli/plugins_dispatch.py` from the reviewed overlay to their identical relative locations in this **new isolated checkout**. Retain the original Git objects, diff and receipt for rollback. Do not apply to an old pilot or running gateway.

```powershell
$taskHermesRoot = [IO.Path]::GetFullPath('C:/PATH/REPO/packages/personal-agent/.runtime/hermes-agent')
$taskReviewedOverlay = [IO.Path]::GetFullPath('C:/PATH/NEW/REVIEWED-OVERLAY')
if ((git -C $taskHermesRoot rev-parse HEAD).Trim() -ne '8d5e3e412138342e8bf30443e72bd4e6a9abd057') { throw 'source_pin_mismatch' }
foreach ($taskRelative in @('cron/jobs.py','cron/scheduler.py','cron/executions.py','hermes_cli/plugins.py','hermes_cli/plugins_dispatch.py')) {
    $taskTarget = [IO.Path]::GetFullPath((Join-Path $taskHermesRoot $taskRelative))
    if (-not $taskTarget.StartsWith($taskHermesRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'target_escape' }
    Copy-Item -LiteralPath (Join-Path $taskReviewedOverlay $taskRelative) -Destination $taskTarget
}
```

Set `runtime-bindings.json`'s `hermesSource.cronPatchReceipt` to the absolute reviewed `patch-receipt.json` path. For a fresh profile, pass the explicit cron inputs during engine preparation:

```powershell
node tools/ops/cli.ts prepare-engine --state 'C:/PATH/NEW/STATE' --plugin 'C:/PATH/REPO/packages/personal-agent/tools/hermes' --provider 'OWNER_SELECTED_PROVIDER' --model 'OWNER_SELECTED_MODEL' --cron-url 'http://127.0.0.1:8789' --hermes-source 'C:/PATH/REPO/packages/personal-agent/.runtime/hermes-agent' --cron-patch-receipt 'C:/PATH/REVIEWED-OVERLAY/patch-receipt.json'
```

Add `hermes.cronUrl` to the deployment config only after this explicit apply step. `prepare-engine`, doctor and launch-plan generation validate the receipt identity and exact SHA256 of all five **already applied** files. They never apply a patch. The launch plan binds those files plus receipt and supplies `NEUROBRO_CRON_BIND=127.0.0.1:8789` only when cron is configured. Without cron configuration, an inherited cron bind is discarded. Runtime cron readiness must additionally prove the exact native markers, required execution admission and execution-bound result manifest through the authenticated extension; file verification is not live scheduling acceptance. Broker admission/grants and effect readback remain required on each occurrence.

## Windowless process recipe

`tools/ops/windows/NeurobroPersonalHost.csproj` is a new WinExe supervisor using the existing repository's GUI/no-console pattern. It verifies the supplied launch-plan hash, executable hash, config/source/plugin hashes and literal argv, clears inherited environment, and imports only named secret references. Different profiles/roles have separate single-owner mutexes. `CreateNoWindow` and hidden child startup avoid a PowerShell/terminal service action. No code here registers a task.

```powershell
dotnet publish tools/ops/windows/NeurobroPersonalHost.csproj --configuration Release --output .runtime/windows-host
node tools/ops/cli.ts launch-plans --config 'C:/PATH/personal-agent.json' --runtime 'C:/PATH/runtime-bindings.json' --package 'C:/PATH/REPO/packages/personal-agent' --destination 'C:/PATH/EMPTY/PLANS' --bridge-bind '127.0.0.1:8788' --broker-url 'http://127.0.0.1:8787/tools/call' --bridge-key-env NEUROBRO_BRIDGE_REGISTRATION_KEY --provider-target OPENAI_API_KEY --provider-source-env NEUROBRO_PROVIDER_OPENAI_KEY
```

The broker URL/port must exactly match the composition root's bound tool server. The default bridge inputs are derived from config/application ports 8788/8787; contradictory overrides and an ephemeral broker port are rejected by this static launch recipe. Replace the provider target with the selected provider's supported key. Plans contain references, not secret values, and generation creates neither processes nor tasks. The launch plans use `python -m hermes_cli.main gateway` with isolated `HERMES_HOME`, and `node src/cli.ts start --config <absolute>` for the broker. Use the environment assembled by the helper; do not invoke the gateway with the owner's inherited home. Fingerprint the plans after they are final, and regenerate whenever any bound source/config/plugin file changes.

After explicit live onboarding/activation, validate the profile marker and exact owned `STOP` before removing that single file. Start the engine plan first and admit its native durable capabilities and trusted bridge readiness; then start the broker plan. Invoke the verified WinExe with `<absolute-plan-path> <plan-sha256>`, using `Start-Process -WindowStyle Hidden` for a temporary manual launch. For later autostart, the scheduled action directly targets that WinExe with those two data arguments and the isolated working directory. Create separately named personal tasks only after authenticated readiness, credential provisioning under the actual run identity and restart tests are accepted. Preserve all historical task XML/Enabled/STOP settings.

The supervisor's Job Object supports owned lifetime cleanup; it is not file/network containment. Job assignment follows trusted process start, so the wrapper alone does not prove hostile early-descendant containment. Orphan cleanup returns exit 80, rather than application-success settlement. Exit 73 is competing ownership, 75 is STOP/reconciliation, 78 is missing supplied environment, and 64/70 are bounded manifest/start failures. A process exit never proves that an external effect was undone.

## Stop, backup and restore

`node src/cli.ts stop --config <absolute>` sets the owned profile STOP and waits for the broker lease. This blocks admission and requests graceful transport closure; it does **not** prove cancellation of already accepted engine runs/jobs. Inspect those through the native engine adapter, retain UNKNOWN effects, and stop the isolated engine with its native gateway stop route. Observe owned process handles/leases and resource settlement before backup. Do not use wildcard PID/process-name kills or start a second sender after an ambiguous stop.

Backup requires STOP, no service/transport/engine/ops lease, and a `SettlementProof` binding profile ID, state directory, timestamp and explicit broker/engine/Telegram physical settlement. Its caller must derive that proof from actual bound process observations; neither elapsed time nor editing the proof file creates evidence. This proof is intentionally stronger than CLI stop's lease result.

```powershell
node tools/ops/cli.ts backup --state 'C:/PATH/STATE' --destination 'C:/PATH/NEW/BACKUP' --settlement 'C:/PATH/settlement.json' --key-env NEUROBRO_BACKUP_KEY
node tools/ops/cli.ts restore --backup 'C:/PATH/BACKUP' --state 'C:/PATH/NEW/RESTORE' --key-env NEUROBRO_BACKUP_KEY
```

Use a separate owner-provided base64 key containing 32 random bytes; retain it independently of the backup. The helper AES-GCM encrypts both file content and the manifest, verifies content/ciphertext hashes, rejects junctions/symlinks, refuses existing/overlapping destinations and retains failed `.partial-*` staging. No secrets or plaintext manifest are printed. Backups include protocol/account state and must stay under the deployment's custody policy.

Restore creates a new directory, preserves journal bytes including UNKNOWN, rebinds profile paths, leaves STOP, and writes `.neurobro-reconciliation-required.json`. It does not rewind Telegram/external effects or resume model execution. Reconcile every interrupted engine run and externally uncertain effect under the original identities, update deployment config paths, and explicitly admit the restored generation before removing the reconciliation marker or STOP. Retain the prior state/backup for rollback.

## Acceptance record

Source tests exercise profile/junction isolation, minimal engine environment, doctor redaction/version mismatch, complete-settlement backup guards, encrypted round-trip, wrong-key/corruption refusal, preservation of UNKNOWN, forward-slash Windows config paths and data-only launch plans. Cron checks connect the exact reviewed five-file overlay to configured/disabled port and credential filters; stock, changed or falsely claimed files are rejected before launch-plan output. .NET source compiles as GUI subsystem 2; an invalid-argv fixture exits without launching a child. These checks establish source/build behavior. Real DLL loading, account login, owner/private-route readback, native engine/cron/provider readiness, secret custody and worker OS boundary remain explicit live prerequisites. No source test is a claim that this personal service is installed or online.
