# Third-party components and provenance

- Telegram transport uses the `telegram` / GramJS npm package pinned in the gateway lockfile. Its package metadata records MIT; the dependency tree also includes `@cryptography/aes` with `GPL-3.0-or-later` metadata. Review the actual lockfile and dependency licenses for any future packaging/distribution plan.
- Rust crates reference crates.io dependencies through Cargo manifests/lockfiles; their sources and binaries are not vendored here.
- Codex App Server is a separately installed external OpenAI component. This repository publishes our bridge/supervision code, not the server implementation or an installed Codex distribution.
- The WSL/Ubuntu image is external and is not redistributed.
- The initial gateway was carried forward from an earlier local AI-assisted project by the same owner and substantially extended here. Historical local file locations and operational records are excluded.

No project-wide license has yet been selected for the original source. This document does not replace third-party license texts or assign a new license to dependencies.
