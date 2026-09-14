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

## Public extraction validation

Checked on Windows on 2026-09-14 against this public source copy:

- TypeScript compilation and all 1,466 gateway tests passed (four test workers).
- Image epoch: 22 Python tests passed.
- Standing epoch client: 29 passed; 18 Linux-only tests skipped on Windows.
- Host, dialogue reader and epoch host: 39 Node tests passed.
- All three Rust crates passed cargo check --locked --offline; native security tests were not run.
- The GUI launcher source compiled as a Windows GUI executable; it was not launched.

Dependencies, compiler output and test logs are not committed. No live Telegram or model operation was performed for these checks.
