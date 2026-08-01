# Provider consolidation and fetch plan

Status: researched proposal. This is a planning surface, not an
implementation contract until reconciled with source and accepted by the
project owner.

## Goals

- Cover useful native and direct search providers without duplicating calls by
  default.
- Preserve evidence, provenance, hard constraints, cost, and rate-limit
  metadata.
- Make page fetching produce clean, bounded, untrusted evidence with one clear
  safety and cancellation boundary.
- Reuse mature code where it reduces risk, without importing incompatible
  fallback chains or heavyweight dependencies.

## Phase 0 — establish the matrix (researched)

The reviewed provider set is now documented in
`ai/research/provider-landscape.md`. The shipped adapters already cover the
important retrieval shapes. The current recommendation is to fix contract and
normalization gaps before adding providers.

1. Treat hard constraints as guaranteed, retrieval hints as hints,
   post-filtering as a bounded adapter behavior, and unsupported options as
   explicit errors.
2. Keep xAI X as the only dedicated social adapter until another provider can
   demonstrate stable citations, source URLs, cost, and rate-limit behavior.
3. Evaluate Perplexity first if a new adapter is justified; it adds structured
   evidence with hard domain/date controls. Evaluate SearXNG separately only if
   self-hosted/keyless search is a real user requirement. Defer Anthropic until
   its Pi model-registry auth and public citation shape are verified.
4. Keep live smoke calls separate from deterministic fixtures and require an
   explicit provider and metered-cost acknowledgement.

## Phase 1 — close contract gaps and harden evidence (implemented)

Commit `a1f51e1` closed the first three gates:

1. The evidence-first boundary no longer forwards an untyped provider `answer`
   field from `src/search-tool.ts`.
2. `src/search-cleanup.ts` now performs conservative URL canonicalization,
   hostname/domain derivation, field bounds, duplicate merging, timestamp and
   score cleanup, and raw `sourceUrl` preservation.
3. The same URL identity is used for `web_research` fetch deduplication. It
   does not rewrite arbitrary query parameters.

Provider adapters still own request construction and payload parsing. Shared
normalization and output bounds remain at the tool boundary; unsupported hard
constraints continue to fail before network access.

## Phase 2 — optimize individual-page fetching (Markdown implemented)

1. Keep pinned direct HTTP, SSRF, redirect, byte, deadline, cancellation, and
   untrusted-content fencing as the default path.
2. Direct transport now prefers `text/markdown`; the worker preserves
   server-provided Markdown as bounded untrusted text and reports
   `extraction: "markdown"` plus the actual content type. JSON/XML/plain text
   remain bounded text.
3. Keep PDF and caption extraction local and bounded. Do not add browser/JS
   rendering to the default path. If demand proves it necessary, add an
   explicit browser mode with per-request/subresource SSRF checks, byte and
   request limits, cancellation cleanup, and a separate privacy review.
4. Do not add caching until repeated-fetch demand is measured. If added, start
   with a bounded in-memory cache keyed by canonical URL plus extraction
   options, with TTL, size, invalidation, and explicit freshness bypass.

## Phase 3 — selective provider additions

The explicit live-smoke harness is now available at
`scripts/live-smoke.ts`; use it only with dedicated credentials and the
acknowledgement described in `docs/live-smoke.md`. Prioritize additions only
after Phases 1–2 and a successful smoke path:

- Perplexity first, only if hard domain/date filters and citation-bearing
  results are still useful beyond the shipped set;
- SearXNG only as an explicitly configured self-hosted endpoint, with engine
  capability warnings and no automatic fallback;
- Anthropic native search only after model-registry auth, search-use billing,
  and citation normalization fit the existing context boundary; and
- Tavily, Z.AI, Claude bridge, or DuckDuckGo only after a concrete coverage
  requirement defeats the overlap or provenance concerns documented in the
  provider matrix.

X/social search remains a capability, not a separate universal tool. xAI X is
already explicit; add another social provider only with stable source URLs,
citations, cost, and rate-limit evidence.

## Non-goals

Do not import automatic provider fallback, paid retries, provider fan-out,
opaque answer synthesis, browser curator/storage, GitHub cloning, telemetry,
or a multi-agent research planner into the default path.

## Decision gate

Before implementation, compare the provider matrix and fetch design against
`docs/DESIGN.md`, `docs/provider-policy.md`, deterministic tests, and the live
Pi configuration. Any copied MIT code must be added to
`THIRD_PARTY_NOTICES.md`.
