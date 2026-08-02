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

### 2026-08-01 — search-plane design correction

The source rebaseline showed two product-level gaps rather than only adapter
bugs: normal search discarded useful native answers, and routing followed only
the active model even when Pi already had authenticated OpenAI/Codex search
models. The implementation now uses a typed untrusted `SearchAnswer` aligned to
normalized citations, searches the Pi registry for an available native
Responses model, and reports the execution model. This supersedes the earlier
active-model-only/evidence-only policy while preserving evidence, provenance,
and safety as the source boundary.

Automatic routing now carries at most one alternative and may use it only for
availability-like failures. The result records attempted providers and a
`provider-fallback` warning. Explicit provider hints and invalid,
unsupported, malformed, or canceled calls remain final. This is the bounded
middle ground between the old extension's broad fallback chain and the earlier
no-fallback policy.

`web_search` now has opt-in bounded source enrichment through the existing
local fetcher (`includeContent`, bounded count/length/deadline). No remote
extractor, browser, persistent history, or provider-comparison mode was added.

### 2026-08-02 — explicit model-mediated Gemini/xAI and safe constraints

Official provider documentation confirms that Gemini Google Search and xAI
web/X search are tools attached to a selected model, not standalone result
APIs. Pi 0.83 supplies Gemini/API-key and xAI subscription/API-key credentials
through its model registry. Keep active Gemini/xAI models automatic, but allow
explicit `provider` hints to select a compatible registry model with a required
`executionModel`; do not discover Gemini/xAI cross-provider credentials
implicitly because search and model-token billing can both apply.

Keep Gemini `generateContent` for now: Google documents it as fully supported,
while the newer Interactions API is recommended for new projects but would not
fix the current adapter's routing or citation problems. Derive Gemini answer
citations from `groundingSupports`, not every retrieved chunk. Distinguish
Gemini search-query usage from token usage.

Map documented xAI X handle/date/image/video options into the typed request
contract. Keep xAI X and the official X recent-search API explicit. Automatic
fallback now only follows authentication, rate-limit, or unavailable failures
known not to have produced a billable result; network, timeout, and
post-dispatch HTTP failures have uncertain effects and remain final.

For search-only Gemini grounding, prefer the current Pi model-registry alias
`gemini-flash-lite-latest` rather than full Flash/Pro or legacy model IDs. The
extension does not silently substitute a model: active-model routing and an
explicit `executionModel` remain the caller-visible billing choice.

The initial 512-token Gemini output cap was arbitrary and caused valid
searches to finish with `MAX_TOKENS`. Google makes generation config optional,
and the mature `pi-web-access` Gemini adapter omits it entirely. Do not add an
unverified model-output cap: the adapter keeps its independent response-byte,
answer-text, and model-visible output bounds, while Gemini controls its normal
model-default generation budget. Follow-up: resolve Google's grounding
redirect URLs to canonical source URLs, as the reference adapter does,
without treating that as a second search.
