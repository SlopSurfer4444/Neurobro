# Scoped native skill reuse

This optional source slice reuses pinned Hermes `skills_list` and
`skill_view(preprocess=False)`. It reads existing approved knowledge; it does
not create skills, infer approval, activate native MEMORY/USER, or grant tools.
Native `skills`/`session_search` remain absent from all exposed toolsets.

Enable only in the isolated profile, with `NEUROBRO_COGNITION_SKILLS_ROOT`
equal to that profile's `HERMES_HOME/skills`. The plugin reports
`cognitionSkills:false` and returns typed unavailable when absent. The loader
checks five pinned source blobs before importing native skill code. Active
native roots must equal this single configured root. No external/project/plugin
skill roots are admitted. This extension does not install or change a profile.

Trusted host setup uses `admitNativeSkill(agent.store, descriptor)` from
`src/hermes/cognition.ts`, and `createPersonalWorkflows` optional
`nativeCognition: {native: new HTTPNativeSkills({baseUrl,registrationKey}),
resolveSession: context => engine.immutableAdmissionSession(context)}`.
The endpoint is the existing numeric loopback bridge management address; its
strong registration key is separate from the opaque model tool credential.
Cron identities require a separately proven scheduler execution binding and
must not be fabricated from model JSON. The foreground resolver rejects cron
and any execution absent from its own admission database.

Descriptors are encrypted metadata in `hermesSkills`:

```ts
{id, nativeName, sha256, ownerId, accountId,
 scope: 'global' /* or chat:<peer>, task:<id> */,
 sourceRefs: [], state: 'approved'}
```

`nativeName` is a relative directory inside the isolated skills root. `sha256`
binds raw UTF-8 SKILL.md bytes, including CRLF/BOM. Empty sourceRefs denotes
operator-installed immutable knowledge; derived knowledge uses current scoped
primary-source revision refs. The model selects only opaque `skillId` through
`learning.skills.list/view`. No model registration, native name/path/session
selector, supporting-file read, provider access or automatic creation exists.
Admission IDs are immutable. A replacement for the same native directory
atomically revokes its prior descriptor; `revokeNativeSkill` is terminal.

Both before and after a native read the host validates authority and admits
the exact descriptor/hash/source dependencies into the execution manifest.
Revocation invalidates existing transcript lineage. Native source drift revokes
the old descriptor before raising an error. Context refresh uses a distinct
execution rather than reviving the invalidated transcript. Original admission
session identity is retained through native transcript compression.

Frontmatter permits scalar `name` and `description` only. Dependency, setup,
environment, shell/template activation metadata and supporting-file reads are
rejected before native invocation: pinned skill_view runs dependency readiness
even when preprocessing is off. Native content is compared against its official
UTF-8/newline rendering, while the returned approved raw content and before/after
file proofs preserve the raw-byte digest. Path, readiness, environment and usage
metadata never leave the extension.

Bounds: host requests 32KiB (cognition management ceiling 256KiB); skill responses 512KiB; content 256KiB;
single isolated native catalog 128KiB (native preflight/postread aggregate
256KiB), at most 64 descriptors and 32 refs each. An oversized installed catalog
is unavailable, not partially scanned. No approved descriptors means an empty
list and unavailable capability, even when the extension is configured.

Profile preparation explicitly writes `memory.memory_enabled:false`,
`memory.user_profile_enabled:false`, `skills.inline_shell:false`, and
`skills.template_vars:false`. Broker primary sources and explicit preferences
remain authoritative. A future supported automatic skill creation/provider
integration requires a separate contract and is not implemented here.
