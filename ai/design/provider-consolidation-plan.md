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

## Long-term portfolio target

The target is best-in-class coverage by capability, not the largest provider
count. Multiple adapters are desirable when they create a meaningful quality,
freshness, filtering, social, latency, cost, or provenance advantage. Normal
search still selects one provider per call. Explicit provider selection and
future opt-in comparison are allowed; hidden fan-out, paid fallback, and
ambiguous merged provenance remain disallowed.

Evaluate each provider role against the same dimensions:

- evidence quality, source fidelity, freshness, and citation completeness;
- hard filters and retrieval modes the provider can actually guarantee;
- semantic, keyword, news, document, and social coverage;
- excerpt/context quality and whether it reduces downstream model tokens;
- latency, request/token cost, quota behavior, and rate-limit metadata; and
- authentication, privacy, regional availability, failure behavior, and
  deterministic testability.

Current portfolio roles and gaps:

| Capability | Current best path | Gap or decision gate |
| --- | --- | --- |
| General native search | OpenAI/Codex Responses | Highest immediate correctness and live-verification priority |
| Google-grounded search | Gemini grounding | Model-mediated and metered; no hard domain guarantee |
| General direct keyword search | Brave | Free-credit policy and local admission control need hardening |
| Semantic retrieval/highlights | Exa | Explicit metered path; richer date/deep-search options need evaluation |
| Objective-oriented context | Parallel | Explicit metered path; measure excerpt quality and cost savings |
| Web grounding | xAI web search | Keep as an explicit native alternative |
| Dedicated X retrieval | xAI `x_search` | Evaluate official X API only for exact post/user/archive controls |
| Hard date/path/domain retrieval | Not yet selected | Evaluate Perplexity only if the shipped set cannot guarantee it |
| Self-hosted/privacy search | None | Evaluate SearXNG only for a concrete self-hosted requirement |
| Search plus extraction service | Direct local fetch | Evaluate Tavily/remote extraction only when local fetch misses a required class |

The current shipped set is therefore a deliberate portfolio, not a permanent
provider ceiling. A candidate earns implementation only after a measured gap,
a billing policy, deterministic fixtures, inspectable source URLs, and an
explicit credential-gated smoke case.

## Priority order

### P0 — production correctness and efficiency

1. Harden OpenAI/Codex Responses search against current provider behavior and
   run credentialed live cases for both paths.
2. Keep direct HTML/Markdown/text/JSON fetching the efficient default; verify
   extraction fidelity, SSRF/redirect/cancellation/byte bounds, and PDF text
   cleanup with representative fixtures.
3. Add concurrency-safe Brave free-mode admission control and make the policy
   explicit that free credits are not a separate endpoint or billing guarantee.
4. Preserve a live smoke matrix and record skipped providers as skipped.

### P1 — measurable capability coverage

5. Build a provider-role evaluation harness before adding overlapping adapters.
6. Extend contracts only for demonstrated needs such as date ranges, source
   types, social handles, or provider-specific retrieval intent.
7. Compare xAI `x_search` with the official X API for exact post/user/date
   workflows; keep xAI unless a concrete gap is measured.

### P2 — selective additions and specialized fetch

8. Add Perplexity only if hard date/path/domain filters materially improve a
   required workflow. Consider SearXNG, Tavily, or Anthropic only under their
   specific privacy, extraction, or native-citation use cases.
9. Reconsider browser/JS rendering or remote extraction only after failed-page
   fixtures show direct fetching is insufficient and the separate resource,
   privacy, SSRF, and cost boundary is designed.
10. Keep repository/GitHub, media download/frames/OCR, and visual analysis in
    Pi/Bash/`git`/`gh`/`yt-dlp`/`ffmpeg`/vision workflows unless an actual
    repeated workflow proves the extension must own them.

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

## Phase 4 — required-coverage audit and sole cutover

The prior extension is not a permanent second runtime. Before cutover:

1. Inventory the workflows we actually use from `pi-web-access` and other
   references: provider search, X/social retrieval, individual-page fetch,
   Markdown/HTML/PDF/YouTube extraction, JavaScript-heavy pages, research,
   citation/provenance, and any GitHub or media operations.
2. Mark each workflow required, replaceable by Pi built-ins/Bash, or explicitly
   retired. Do not treat the previous non-goals list as user approval.
3. Implement every required workflow behind the existing bounded, untrusted,
   evidence-first contracts. Browser rendering, remote extraction, caching,
   repository helpers, and media features require their own SSRF/resource/
   privacy review rather than being added by default.
4. Run deterministic fixtures, Pi registration checks, credentialed live smoke
   calls, and representative end-to-end workflows. Remove the prior active
   extension only after all required rows pass.

## Non-goals unless the needs inventory requires them

Automatic provider fallback, paid retries, provider fan-out, opaque answer
synthesis, telemetry, and curator/storage behavior remain disallowed by policy.
Other previously deferred features are hypotheses, not permanent exclusions;
the needs inventory decides whether pi-search must implement them or whether a
Pi built-in/Bash workflow correctly owns them.

## Decision gate

Before implementation, compare the provider matrix and fetch design against
`docs/DESIGN.md`, `docs/provider-policy.md`, deterministic tests, and the live
Pi configuration. Any copied MIT code must be added to
`THIRD_PARTY_NOTICES.md`.
