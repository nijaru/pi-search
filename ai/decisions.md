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

### 2026-08-01 — required workflow scope

The sole replacement target is capability-complete for the workflows actually
requested: native OpenAI/Codex-first search, controlled direct-provider search
for local models, Gemini, Brave, Exa, Parallel, explicit xAI X, evidence
cleanup, direct page/PDF/YouTube-caption fetch, and bounded multi-query
research. `pi-web-access` feature parity is not the target. Fan-out, opaque
answers, persistent history, GitHub cloning, media vision/OCR, browser or
remote extraction, caching, and additional overlapping providers remain
outside the runtime until a concrete workflow demonstrates that they are
required. This keeps one owner without importing hidden cost, privacy, or
resource behavior.

### 2026-08-01 — sole runtime cutover

After offline fixtures, installed registration, and a fresh Pi Codex call
passed, `pi-web-access` was removed from the active Pi package list. Dedicated
live credentials for the other providers were absent, so those rows are
recorded as skipped rather than treated as passing. Existing Pi processes must
restart to observe the package-list change.

### 2026-08-01 — long-term provider portfolio

The sole-runtime cutover is not the long-term provider ceiling. The package
should support multiple best-in-class providers when they materially improve a
capability such as evidence quality, freshness, hard filtering, social search,
context efficiency, latency, cost, or provenance. Ordinary calls still select
one provider; explicit provider selection and a future opt-in comparison mode
are acceptable. Hidden fan-out, paid fallback, and opaque synthesis remain
out of contract. OpenAI/Codex correctness and direct fetch/PDF efficiency are
P0; provider-role evaluation precedes overlapping additions; xAI `x_search` is
the current dedicated X path while the official X API is a conditional
candidate for exact post/user/date workflows. Current official X documentation
confirms that it complements rather than replaces xAI `x_search`; implement it
only as an explicit, separately billed provider.

### 2026-08-02 — native-first and compact-output direction

The next implementation phase prioritizes production correctness over adding
providers: active-model native search first, Exa as the automatic non-native
path when its configured key is present, and other direct providers only as
explicit or later availability-based options. A provider error remains final;
selection fallback based on availability must not become retry or fan-out.
Gemini grounding is native-only because routing another model through Gemini
would create a separate model/token bill. Brave is a last-resort keyword/fresh
provider, not the general semantic default.

All three public tools need two deliberate output layers: compact readable
model-visible content and a compact default Pi TUI renderer with expanded
structured details on demand. Raw JSON is not an acceptable normal chat
presentation. The old extension's collapsed result renderer is a reference for
presentation only; its fallback, synthesis, and storage behavior is not being
imported until the required workflow review below is complete.

### 2026-08-02 — pause sole-replacement work and rebaseline against prior extension

The user is returning to `pi-web-access` operationally because its actual
source provides behavior that currently makes search feel better: it scans all
authenticated OpenAI/Codex registry models even when another model is active,
returns a synthesized answer alongside sources, and has broader configured
routing/fetch/curation workflows. `pi-search` currently has an OpenAI/Codex
adapter but only routes it when the active model itself is OpenAI/Codex; an
OpenRouter/DeepSeek session therefore uses Exa instead. This is a confirmed
source-level parity gap, not evidence that another provider is better.

Decision: stop provider-comparison calls and do not add providers for coverage
alone. Treat the prior extension as the operational baseline, research actual
workflow differences from source and configuration, and design the smallest
parity/advantage plan before further implementation. The one-provider,
bounded-network, evidence-first constraints remain provisional until that plan
resolves whether cross-provider native search and optional answer synthesis
are required.
