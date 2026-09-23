# Testing and deployment boundaries

## Gateway

Run from `packages/telegram-gateway`: `npm ci --ignore-scripts`, then `npm test`.
Node.js 24.15+, npm 11, Git and Python 3.12+ are required. `NEUROBRO_TEST_PYTHON` can specify a Python executable. Git must resolve to a native executable, not a Windows command shim. The gateway tests use synthetic messages and temporary encrypted stores, not live Telegram credentials.

## Model bridge

Python `*.test.py` files in `project/verification` contain offline protocol/session tests. Some checks require Linux and are explicitly skipped on other platforms. They are different from a live model/WSL deployment test. The model runtime is not started merely by running those unit tests.

## Windows Rust experiments

The Rust crates are Windows-specific and have shared fixtures in `packages/rm0032-phase3-runner`. Some native security tests require explicit environment preparation. Do not interpret a portable contract test as proof that Windows isolation or a live guest launch has been accepted on another machine.

## Runtime reference sources

The host and GUI launcher illustrate the deployed lifecycle. They retain version/hash contracts and example installation paths. They are not a supported generic installer. Installed Codex, WSL image, runtime manifests, identity bindings and secret provisioning are not distributed. A fresh deployment requires deliberate configuration and validation.

## Initial public extraction validation (historical)

Checked on Windows on 2026-09-14 against this public source copy:

- TypeScript compilation and all 1,466 gateway tests passed (four test workers).
- Image epoch: 22 Python tests passed.
- Standing epoch client: 29 passed; 18 Linux-only tests skipped on Windows.
- Host, dialogue reader and epoch host: 39 Node tests passed.
- All three Rust crates passed cargo check --locked --offline; native security tests were not run.
- The GUI launcher source compiled as a Windows GUI executable; it was not launched.

Dependencies, compiler output and test logs are not committed. No live Telegram or model operation was performed for these checks.

## Public refresh validation (2026-09-23)

Checked against the refreshed public copy on Windows:

- Full gateway run: 2,137 tests, 2,125 passed and 12 failed. The failures exposed an explicit-maintenance continuation guard regression (2 tests) and a Windows Git command-shim fixture issue (10 tests).
- After the narrow repairs, the affected gateway cohorts passed 18/18 and TypeScript compilation passed. The 2,125 unaffected tests were not rerun; this is not a claim of a second complete green run.
- Native bridge Node cohorts passed 86/86. Python conversation tests passed 62/62; epoch client passed 42 with 18 platform skips.
- Parallel Python cohorts: pool 21, session 20, supervisor 22 passed; adapter skipped 7, client passed 5/skipped 2, wire passed 1/skipped 1.
- Existing epoch supervisor passed 31 with one explicit Linux-only loopback skip on Windows. That loopback shutdown test timed out on Windows in isolation; actual Linux loopback behavior was not verified in this refresh. No production relay change was made to hide that limitation.
- Independent public-tree privacy and source review completed. Private deployment state, credentials, chat records and private Git history are excluded.

These are offline source checks, not a new live deployment or an uptime measurement.
