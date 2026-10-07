# TDLib transport boundary

`TdlibTelegram` implements `TelegramPort`. Construct it with `{ accountId,
transport, receipts, spool? }`. `JsonProcessTransport` receives an absolute
Python executable and args `[sidecarPath, '--library', dllPath,
'--expected-sha256', digest]`; the child has `windowsHide: true`, no shell, and
a minimal environment unless the host explicitly supplies `env`.
Call `transport.start()` explicitly, then await `transport.waitReady()` before
the first RPC when using the Python sidecar. Startup has its own bounded
deadline; the per-request timeout starts after native readiness. This creates the native client but does
not send parameters or authenticate. `authStatus()`, `configureParameters()`
and `submitAuth()` are trusted host onboarding interfaces. The host may use
`invoke()` for other pinned-schema functions; it is never a model tool.
`getMe` must match `accountId` before observations or effects are admitted.

`FileTelegramStore(directory, 32ByteKey)` stores an AES-GCM append journal and
fsyncs receipts before native dispatch. The host owns key custody, directory
ACLs and retention. A torn journal refuses admission. Supply the same store
as `receipts` and `spool` for durable intake. After broker admission succeeds,
call `acknowledgeObservation(observation.id)`; unacknowledged observations
replay after cold reopen. Store updates precede observation publication.
TDLib does not promise replay of the app's lost receive window, so `status()`
reports `snapshot-only` or `gap`, never fabricated complete coverage.

Effect capabilities use plain host-prepared payloads from `requests.ts`:
text, replies, trusted staged media paths, polls, reactions, callbacks selected
from fresh markup, profile fields, scheduled messages and joining an exact
peer. `telegram.send` is the core delivery alias. `payload.tdlib` is rejected;
model input cannot override native methods, source peers or spend options.
Participant group IDs are resolved from the granted chat. Topic constructors
are bound by reading their source message, because a bare topic ID does not
identify Forum/Thread/SavedMessages semantics. Media download tokens require
a fresh original-message read and reject protected/self-destructing content.

Native send admission is pending, not delivered. The store retains transient
`sending_id`, temporary and final message IDs; terminal updates are serialized
with initial responses so late responses cannot erase final mappings. Only an
exact peer/message/content/reply/topic/schedule readback yields `verified`.
Unknown or repeated effect IDs reconcile without another `sendMessage`.
Terminal message mappings remain stable when late pending or contradictory send
updates arrive. Correlation by `sending_id` also requires the exact peer.
Safe native error codes and allowlisted reasons survive refusal receipts; raw
native diagnostic text is not copied into them. Live interaction updates replace
the source reaction state and invalidate its version.
Albums require separate durable per-item effects and are not exposed here.
Callbacks and avatar ACKs remain unknown when semantic readback is unavailable.
Native TDLib can continue an already admitted send after grant cancellation;
the broker must stop future dispatch and reconcile in-flight effects.

`td_api.tl` and `schema-source.json` pin the official source commit and digest.
Validation checks fields and constructor types against this source, not an
assumed workstation DLL. Sidecar doctor checks an explicit file/hash without
loading it and reports `native_api_verified: false`.

Run `node --test test/telegram/telegram.test.ts` from the package. Set
`NEUROBRO_TEST_PYTHON` to an existing Python executable to include the actual
sidecar/fake-ABI subprocess smoke (no native DLL or account). A native DLL,
packaged build provenance, database lifecycle and real-account acceptance
remain deployment/onboarding gates; these source tests do not claim them.

Text edits select text or caption methods from a fresh owned native target and
preserve caption placement. File-profile uploads disable native content-type
detection to retain document presentation. Downloads require the exact native
file identity, source size and complete local bytes before copying. Round-video
sends require trusted length metadata of 1–640; the current public preparation
path does not derive it, so missing metadata is refused before dispatch.
Poll verification includes anonymity, multiple-answer policy and poll type.
When TDLib hides a quiz answer or explanation, its delivery remains UNKNOWN;
reconciliation never casts a vote or resends it to obtain proof.

Normalized observations retain UTF-16 `authorityTextRanges` for native quotes and
code spans in text and captions. Recognized malformed spans fail closed across
the full text. The dialogue owner consumes this provenance for command and
approval authority; visible message text remains intact for ordinary reading.
# Source and author metadata

`resolvePeer(selector)` resolves an exact decimal peer ID, `@username`, or Telegram public/private message link to a stable typed peer. Username lookup checks the refreshed user's or group's active aliases. `resolveMessageLink(url)` returns the message reference supplied by pinned TDLib; it never converts the visible link number into a TDLib message ID. Metadata resolution does not grant history access, joining, or sending.

Observations preserve native `forwardOrigin`. `resolvePostAuthor(ref)` refreshes the exact post and returns sender and forwarding provenance. A known forwarded user can resolve to a private peer through `createPrivateChat(force:false)`; this creates no message or membership. Hidden names, channel signatures, and anonymous chat senders never become individual identities. Imported posts without native origin remain unresolved.

Discovery returns `{peers, coverage:'bounded', truncated?}` with a validated limit of 1–100. An exact selector uses exact resolution; other queries hydrate the bounded native search results. `readCapability('telegram.message.author', {peerId,messageId})` returns the same typed author metadata within the caller's separately granted message scope.
