# Third-party components and provenance

- Telegram transport uses the `telegram` / GramJS npm package pinned in the gateway lockfile. Its package metadata records MIT; the dependency tree also includes `@cryptography/aes` with `GPL-3.0-or-later` metadata. Review the actual lockfile and dependency licenses for any future packaging/distribution plan.
- Rust crates reference crates.io dependencies through Cargo manifests/lockfiles; their sources and binaries are not vendored here.
- Codex App Server is a separately installed external OpenAI component. This repository publishes our bridge/supervision code, not the server implementation or an installed Codex distribution.
- The WSL/Ubuntu image is external and is not redistributed.
- The initial gateway was carried forward from an earlier local AI-assisted project by the same owner and substantially extended here. Historical local file locations and operational records are excluded.

No project-wide license has yet been selected for the original source. This document does not replace third-party license texts or assign a new license to dependencies.

## Personal composition — 7 October 2026

- **Hermes Agent, Nous Research:** external engine pinned at `8d5e3e412138342e8bf30443e72bd4e6a9abd057`. The five modified upstream Python source files and patch in `packages/personal-agent/tools/hermes/patches/native-overlay-v2-final/` are derivative integration work, not an original engine. Keep [the MIT notice](packages/personal-agent/tools/hermes/patches/LICENSE.Hermes), [upstream license](https://github.com/NousResearch/hermes-agent/blob/8d5e3e412138342e8bf30443e72bd4e6a9abd057/LICENSE) and [patch provenance](packages/personal-agent/tools/hermes/patches/native-overlay-v2-final/patch-receipt.json). The complete runtime and its dependency environment are not distributed.
- **TDLib, Telegram:** `packages/personal-agent/src/telegram/td_api.tl` is the upstream API schema pinned at `42e6a5259551178d1dab54a22ad96d14bd906e20`, with source URL and content hash in `schema-source.json`. Keep [Boost Software License 1.0](packages/personal-agent/src/telegram/LICENSE.TDLib), [upstream source](https://github.com/tdlib/td/tree/42e6a5259551178d1dab54a22ad96d14bd906e20). No compiled TDLib binary is bundled.
- Development dependencies are pinned in the personal package lockfile: TypeScript (Apache-2.0), `@types/node` and `undici-types` (MIT). Their installations remain separate.
- Original work in the personal package is the TypeScript authority/task broker, TDLib sidecar and Hermes bridge/plugin integration, developed with AI coding agents. The upstream schema and modified engine overlay retain their original authorship and licenses. No project-wide license is assigned to the original code by this update.
