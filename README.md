# Neurobro

**A Telegram group assistant with bounded conversation memory, tools, and optional initiative.**

An experimental assistant developed through real group use. The project connects a Telegram user-account gateway to a model session running through Codex App Server in WSL. It handles replies, images, files, history tasks and Telegram actions while tracking whether operations actually completed.

[Русское описание](README.ru.md) · [Architecture](docs/architecture.md) · [Design notes](docs/design-notes.md) · [Testing](docs/testing.md) · [Publication scope](docs/publication.md)

## What is here

| Component | Role |
| --- | --- |
| `packages/telegram-gateway` | TypeScript/GramJS gateway, conversation selection, bounded context, encrypted journals, history tasks, tools, delivery and recovery logic |
| `project/verification` | Python/Node model-session bridge, image handling, process supervision, offline tests and Windows runtime reference sources |
| `crates` | Our experimental Windows Rust runner, native observer and launcher/hardening components |
| `packages/rm0032-phase3-runner` | Paired TypeScript contracts, fixtures and tests for the experimental Rust components |

The Rust **Codex App Server is an external dependency**, not an implementation authored in this repository. The active model bridge is Python/Node. Our own Rust crates belong to an earlier Windows native-isolation track and are kept as engineering reference, not presented as the active WSL server.

## Capabilities implemented

- Direct requests, replies, optional conversational continuations and initiative with cooldowns and silence decisions.
- Bounded recent context, persisted own-action facts and incremental history-analysis tasks with recorded coverage.
- Image input and generation handling; artifact delivery; profile/group actions, participants, polls and reactions through scoped tools.
- Encrypted local state, operation records, delivery readback and explicit unknown outcomes instead of blind replay.
- Process/session settlement and recovery; a Windows GUI-subsystem launcher that avoids allocating a visible terminal.

Individual live outcomes and offline checks are different evidence. Features were exercised in a real group, but this is **an experimental system, not a claim of production readiness or guaranteed 24/7 availability**. Social timing, universal retrieval of old media, portable deployment and broader model routing remain incomplete.

## Run the offline gateway checks

Requirements: Node.js 24.15 or newer compatible 24.x, npm 11, Git, and Python 3.12+ for the image-collector integration test. On Windows, use a real Git executable on PATH; a `.cmd` shim cannot be passed directly to Node's `execFile`.

```sh
cd packages/telegram-gateway
npm ci --ignore-scripts
npm test
```

If Python is not available as `python`, set `NEUROBRO_TEST_PYTHON` to its executable path. These tests use synthetic data and mocked Telegram/model boundaries; no Telegram credentials or live model session are required.

The full WSL deployment is **not a one-command installer in this publication**. Runtime reference files retain version-specific integrity contracts and require a separately configured environment, account binding and dependency installation. Do not execute historical operators as setup instructions. See [testing and deployment boundaries](docs/testing.md).

## Development and provenance

Developed iteratively with AI coding agents, with owner-led requirements, live testing and review.

This is a source-only snapshot of the project. It contains no original Git history, production chat exports, credentials, session files, installed binaries or WSL image.

## Licensing

No project-wide license has been selected for the original source in this publication. Third-party dependencies retain their own licenses; they are referenced by manifests/lockfiles and are not vendored. See [third-party notes](THIRD_PARTY.md).
