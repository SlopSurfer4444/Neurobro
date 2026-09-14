# What was copied from OpenClaw, and what was intentionally changed

Checked on 2026-08-07.

## Source finding

OpenClaw's official Telegram channel is a bot-token integration built on grammY. It is not a
personal-account userbot. The personal-account path is the community plugin
[`eldaruma/telegram-userbot`](https://github.com/eldaruma/telegram-userbot), which uses:

- Telegram MTProto rather than Bot API;
- GramJS (`telegram` npm package), not Python/Telethon;
- an `api_id`, `api_hash`, and serialized `StringSession`;
- one long-lived `TelegramClient` and `NewMessage` event handler;
- direct/group allowlists and OpenClaw channel routing.

Reference snapshot inspected locally: plugin commit
`8af484b730062f561dfce439b3e3af4d8514efab`; GramJS commit
`3dc2346fb15ee5a73a03bce3bd191e7d28c76f06`.

## Why this implementation is stricter

The community plugin is designed to reply as the user. It can send messages/media, set typing,
mark messages read, accepts wildcard examples, and leaves most retry behavior to GramJS. That is
the wrong default for conservative information ingestion.

This module keeps only authentication, the MTProto client, exact-peer resolution, bounded history,
and `NewMessage` updates. It adds:

- hard `read-only` mode with no outbound Telegram methods;
- numeric peer IDs only and no wildcard/username discovery;
- a single-process lock to avoid duplicated main sessions;
- persistent minute/hour/rolling-day request budgets and a minimum interval;
- surfaced `FLOOD_WAIT` with a persisted safety-margin cooldown and zero flood retry;
- bounded retry only for network/5xx errors, plus a persistent circuit breaker;
- bounded backfill, pages, sources, lookback, and live-event buffer;
- encrypted `StringSession`; no session string is printed or put in JSON config;
- metadata/text JSONL export only; media is never downloaded;
- no built-in LLM/OpenClaw forwarding.

## Terms and unavoidable risk

Telegram says unofficial API clients are monitored, flooding/spam can lead to a permanent ban, and
server limits are dynamic. Therefore no software can truthfully promise zero ban risk. Telegram's
current API terms also prohibit using API-obtained data for AI/ML training, development, enhancement,
or deployment. This module requires an explicit no-AI-development acknowledgement and treats every
exported message as untrusted input.

Primary sources:

- [Telegram: Creating your application](https://core.telegram.org/api/obtaining_api_id)
- [Telegram: API Terms of Service](https://core.telegram.org/api/terms)
- [Telegram: User authorization](https://core.telegram.org/api/auth)
- [Telegram: Error handling and FLOOD_WAIT](https://core.telegram.org/api/errors)
- [OpenClaw official Telegram bot channel](https://github.com/openclaw/openclaw/blob/main/docs/channels/telegram.md)
- [OpenClaw community GramJS userbot](https://github.com/eldaruma/telegram-userbot)

## Dependency adoption record

- classification: repo-local dependency;
- channel: existing workstation Node/npm launcher, local `node_modules`;
- pinned module: `telegram@2.26.22`, integrity locked by `package-lock.json`;
- global install/PATH/launcher/workstation manifest: none;
- residual risk: the npm package currently marks itself deprecated in favor of `teleproto`; this
  build remains pinned because it matches the inspected OpenClaw plugin, and upgrades must be an
  explicit reviewed change.
