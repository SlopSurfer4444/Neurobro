# Personal Neurobro — development snapshot, 7 October 2026

Current source: [packages/personal-agent](../packages/personal-agent). It is independent of the historical group gateway; it does not inherit its session, memory or live permissions.

`Telegram account → supervised TDLib Python sidecar → TypeScript broker → external Hermes`

The broker controls owner commands, resource grants, task revisions, encrypted state and effect receipts. Hermes supplies model execution and optional native schedules. Model completion and verified Telegram delivery are separate results; uncertain external outcomes require reconciliation before a retry. These source mechanisms are not a guarantee that every account/provider scenario has passed live acceptance.

## Safe local checks

Use Node.js 24.15+ compatible 24.x, npm and installed Python for applicable Python checks. From `packages/personal-agent`:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
node src/cli.ts help
```

The unit tests use synthetic messages and isolated temporary state. Do not automatically execute opt-in live probes. Python tests requiring the pinned external Hermes installation have a separate prerequisite; its runtime is not copied into this source snapshot. See [actual results](../PERSONAL-VALIDATION.md).

[Package operations](../packages/personal-agent/docs/operations.md) explain optional preparation and live activation. Examples contain placeholders: supply a new private state directory and your own account/provider configuration. Existing tasks and schedules must be reconciled separately before activation. Source checks grant no permission to log in, send, install autostart or activate old queues.

## Published boundary

[Source admission](../PERSONAL-SOURCE-ADMISSION.json) records original byte hashes, exclusions, supplementary companions and transformations. [Public manifest](../PERSONAL-SOURCE-MANIFEST.json) binds the final copied bytes. No original private Git history, chat contents, credentials, sessions, operational evidence or generated binaries are published. Third-party license notices are linked in [THIRD_PARTY.md](../THIRD_PARTY.md).
