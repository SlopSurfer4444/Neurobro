# Personal source validation - 7 October 2026

This report applies to the public personal-agent source copy described in PERSONAL-SOURCE-ADMISSION.json. It is separate from historical group-version checks.

- Pinned repo-local development dependencies installed with `npm ci --offline --ignore-scripts --no-audit --no-fund --fetch-retries=0`. The first network install stalled and was stopped; no global tooling or runtime was installed.
- `node node_modules/typescript/bin/tsc -p tsconfig.json`: PASS (noEmit).
- Standard Node unit glob `node --disable-warning=ExperimentalWarning --test --test-reporter=spec 'test/**/*.test.ts'`: 664 tests, **656 passed, 7 failed, 1 skipped**. The seven failures were synthetic PDF decoder and fake Hermes request timeouts under default parallelism; this run is not reported as PASS.
- Focused rerun `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-reporter=spec test/artifacts/pdf.test.ts test/documents/tools.test.ts test/hermes/adapter.test.ts`: **24 passed, 0 failed, 0 skipped**, including the seven previously failed scenarios. No clean rerun of the entire 664-test glob is claimed. No timeout values or assertions were relaxed.
- Independent source privacy/license/code review: no real user data, credentials, runtime/build output or account-specific desktop probe in the Git payload. Both license notices and all five Hermes overlay hashes were verified. Pattern scans are not proof against every possible arbitrary secret format.

The Node tests use isolated synthetic state and substitute services. No Telegram login/read/send, real model/provider request, runtime activation, old queue/schedule execution or autostart occurred. Python tests requiring the separately pinned external Hermes source, Windows .NET launcher build and actual account/provider acceptance were not run here. Source mechanisms and unit checks do not establish live readiness, response quality or measured uptime/latency.

Historical group-version reports remain in docs/testing.md and the public Git history.

Formatting check: `git diff --cached --check` retains 28 trailing-whitespace warnings in the upstream-derived unified patch. These are required single-space empty context lines; patch bytes and provenance were preserved. Redundant blank lines at EOF were removed.
