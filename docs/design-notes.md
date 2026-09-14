# Design notes

## Problem

A group assistant that technically returns text can still feel unusable: it loses its own previous answer, misses short continuations, interrupts unrelated conversations or leaves users waiting after a failed image generation.

## Approach

The project was developed through a working Telegram integration and owner-led group testing. AI coding agents assisted implementation and independent source review. Fixes targeted lifecycle and context classes rather than hardcoding individual chat messages.

| Observed problem | Engineering response |
| --- | --- |
| Short answer to the assistant's invitation was missed | Separate continuation assessment with the preceding own message in bounded context |
| Unwelcome repeated initiative | Own-output cooldown, direct-request priority and explicit silence |
| Deleted/edited queued message stopped unrelated work | Local stale-selection handling before model admission |
| Image generation failed and blocked conversation | Confirmed generation failure becomes an honest text outcome; uncertain lifecycle remains unknown |
| Upload refusal was indistinguishable from an uncertain send | Typed pre-dispatch failure, joined settlement and a durable terminal record |
| Avatar request changed during upload | Final request revalidation before the mutation |
| Later requests lacked evidence of prior actions/history work | Persisted bounded action/task facts, with explicit source and coverage limits |

## Evidence

The private development version completed 1,466 gateway checks plus native Python/Linux, host and Windows-launcher checks. It was deployed and used in a real group. That historical evidence does not establish every feature as live-accepted or prove the public extraction unchanged. Public-copy verification is recorded separately in [testing](testing.md).

## Tradeoffs and unfinished work

Conservative unknown-outcome handling reduces blind duplication but can require operator reconciliation. Bounded context controls input growth but cannot guarantee perfect recall. Social initiative needs live evaluation beyond deterministic tests. The environment-specific runtime has stronger version binding than installation portability. These are constraints of the current design, not hidden completed features.
