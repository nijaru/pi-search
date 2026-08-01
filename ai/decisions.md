# Decisions

## Principles

1. Return inspectable evidence and provenance by default. Provider-generated
   answers are optional and never authoritative at the public search boundary.
2. Select one provider for ordinary search. Provider failure does not trigger a
   hidden fallback, paid retry, or provider fan-out.
3. Treat search modes as hints when a provider cannot guarantee them, but never
   silently drop hard constraints such as domain filters.
4. Keep direct fetching local to the extension. Validate DNS/IP targets and
   redirects, bound response and extraction resources, propagate cancellation,
   and fence remote content as untrusted data.
5. Keep the default test suite deterministic and offline. Live provider calls
   are explicit, credential-gated, rate-limit-aware smoke checks.
6. Prefer mature existing Pi implementations for adapters and extraction, but
   preserve this package's contracts and policy. Copying MIT code requires
   attribution in `THIRD_PARTY_NOTICES.md`.

## Log

### 2026-08-01 — unversioned Git package

The package has no semver field or release tag. Pi installation uses the public
Git source `git:github.com/nijaru/pi-search`. The earlier temporary `v0.1.0`
release and tag were removed because this package is intentionally unversioned.

### 2026-08-01 — coexist with pi-web-access

Keep `pi-web-access` installed for capabilities outside this package's scope,
but disable its duplicate search registration in the active Pi configuration.
This preserves rollback and specialty workflows without registering competing
search tools.
