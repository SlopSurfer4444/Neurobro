# Design decisions

## Account-based integration

Neurobro participates through an authenticated Telegram user account. GramJS/MTProto supplies the transport; exact peer bindings and scoped tools supply application boundaries. This separates the identity in Telegram from the model and its tools. No BotFather bot is needed for this gateway.

## Conversation as a continuous workflow

The next model turn receives relevant recent conversation, reply anchors, prior assistant actions, learning and task observations. Direct calls, conversational continuations and optional initiative have different selection paths. Silence is an explicit valid outcome.

## Bounded context, durable work

Memory and task storage are separate from the prompt. Search and history tools retrieve relevant material, and long-period analysis records coverage and saved intermediate results. Larger packets and retained workspaces reduce repeated overhead; parallel analysis remains subject to lifecycle and resource admission.

## Reports as artifacts

An internal analysis summary is not automatically the user-facing report. Finalization drafts and reviews a distinct report using saved materials. Delivery handles Telegram-sized parts, readback and uncertain outcomes independently of the report's content.

## Recovery before repetition

The system distinguishes confirmed failure, saved progress and uncertain external effects. A later worker reconciles ownership and preserved results before continuing. An unknown send is not silently turned into a fresh send; a finished analysis need not be repeated merely because delivery failed.

## AI-assisted engineering

AI coding agents were used for implementation, tests and review. The project author owned requirements, architecture choices, integration priorities and acceptance in real group use. Independent review and deterministic checks serve different purposes: agreement between reviewers is not a substitute for exercising a scenario.

## Evidence and scope

Offline checks use synthetic messages, fake transports and temporary state. Live development also exercised the assistant in Telegram groups. The public-copy checks are recorded in [testing](testing.md), separately from historical deployment evidence. Group records and credentials are not part of this repository.
