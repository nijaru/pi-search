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

### 2026-08-01 — temporary migration, final sole ownership

`pi-web-access` may remain installed only while pi-search is being completed and
validated. The final runtime must have one owner: pi-search must cover the
required search, fetch, research, social, and specialty workflows before the
prior extension is removed or left inactive. The prior extension is a source
reference and temporary rollback aid, not an accepted permanent second tool
surface.

This supersedes the earlier coexistence decision as the target state. The
one-provider, evidence-first, explicit-cost, bounded-network principles remain
in force.
