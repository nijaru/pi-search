# Provider consolidation and fetch plan

Status: search/fetch baseline implemented and pushed through `7e263c0`,
including local AnyDoc conversion/PDF routing and Pi 0.84 compatibility. The prior
extension remains the operational reference. No provider-comparison calls or
provider additions are planned until a concrete coverage gap is identified.

## Goals

The quality bar is task usefulness, not adapter count or strict parity with
`pi-web-access`. A normal search should produce a useful, citation-bearing
answer or high-quality evidence/context for the active model, work without
unnecessary provider configuration, and remain bounded and inspectable.

Borrow the strongest ideas from reviewed extensions:

- `pi-web-access`: availability-based auth resolution, answer-plus-citation
  presentation, optional source content, multi-query workflows, and compact
  interaction;
- `pi-web-providers`: typed capability definitions and centralized execution
  policy;
- `pi-search-hub`: URL identity, deduplication, reader dispatch, and explicit
  provider health state; and
- `pi-deep-research`: auditable source/citation records where a deeper research
  workflow actually needs them.

Do not import their broad provider fan-out, opaque synthesis, persistent
history, browser curator, or remote extraction without a separate contract.

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
| General non-native semantic search | Exa | Direct path is reliable in fixtures and one smoke; automatic routing and end-to-end OpenRouter behavior need completion |
| General direct keyword/fresh search | Brave | Last-resort path; free-credit policy and local admission control need hardening |
| Objective-oriented context | Parallel | Explicit metered path; measure excerpt quality and cost savings |
| Web grounding | xAI web search | Keep as an explicit native alternative |
| Dedicated X retrieval | xAI `x_search` plus the shipped explicit X API recent-search path | xAI is best for semantic/model-mediated context; dedicated X lookup/user/archive gaps remain |
| Hard date/path/domain retrieval | Not yet selected | Evaluate Perplexity only if the shipped set cannot guarantee it |
| Self-hosted/privacy search | None | Evaluate SearXNG only for a concrete self-hosted requirement |
| Search plus extraction service | Direct local fetch plus local `@firecrawl/anydoc` document conversion | Evaluate hosted/remote extraction only when local fetch misses a required class |

The current shipped set is therefore a deliberate portfolio, not a permanent
provider ceiling. A candidate earns implementation only after a measured gap,
a billing policy, deterministic fixtures, inspectable source URLs, and an
explicit credential-gated smoke case.

## Priority order

The earlier provider-first priority is superseded. The search-plane quality
review is implemented: typed answer/evidence output, registry-driven native
resolution, one visible fallback, and opt-in safe source enrichment. The
remaining priority is fresh-Pi and credential-gated acceptance, not provider
comparison.

### Rebaseline quality gates

1. Define the normal `web_search` result contract: useful answer or evidence,
   citation fidelity, backend/model attribution, source depth, and bounded
   output.
2. Resolve available search backends independently from the active model when
   policy permits; make cross-provider billing explicit instead of silently
   assuming active-provider-only search.
3. Add bounded, observable resilience for unavailable providers, with no
   unbounded fan-out or retry loops.
4. Verify the actual Pi UI/tool path with deliberate GPT/OpenRouter/Codex
   workflows before claiming replacement readiness.

### P0 — production correctness, output, and efficiency

1. Harden OpenAI/Codex Responses search against current provider behavior and
   run one credentialed live case per path when credentials permit.
2. Add compact model-visible content and old-extension-style collapsed/expanded
   Pi renderers for `web_search`, `web_fetch`, and `web_research`; keep full
   structured details separate from normal chat output.
3. Make Exa the automatic non-native path when its key is configured and verify
   the OpenRouter/DeepSeek route without fallback after provider errors.
4. Keep direct HTML/Markdown/text/JSON fetching the efficient default; verify
   extraction fidelity, SSRF/redirect/cancellation/byte bounds, PDF cleanup,
   and research output bounds with representative fixtures.
5. Preserve a live smoke matrix and record skipped providers as skipped.

### P1 — measurable capability coverage

5. Build a provider-role evaluation harness before adding overlapping adapters.
6. Extend contracts only for demonstrated needs such as date ranges, source
   types, social handles, or provider-specific retrieval intent.
7. Expand the official X API only if exact post lookup, user timelines, or
   date/archive workflows become required; keep xAI `x_search` for semantic
   context.

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
constraints continue to fail before network access. The model-facing request
schemas now expose the actual defaults and non-arbitrary finite bounds:
source enrichment follows the public 20-result maximum, and each fetched page
may request up to 32,000 characters. Global model-visible output limits,
response-byte limits, deadlines, cancellation, and SSRF remain the resource
owners. Search and research stop source enrichment when their aggregate output
budget cannot retain another page. Parallel maps `maxResults` to its
documented `advanced_settings.max_results` field instead of relying on a
server default.

## Phase 2 — optimize individual-page fetching (Markdown implemented)

1. Keep pinned direct HTTP, SSRF, redirect, byte, deadline, cancellation, and
   untrusted-content fencing as the default path.
2. Direct transport now prefers `text/markdown`; the worker preserves
   server-provided Markdown as bounded untrusted text and reports
   `extraction: "markdown"` plus the actual content type. JSON/XML/plain text
   remain bounded text.
3. Keep PDF and caption extraction local and bounded. `@firecrawl/anydoc`
   now converts local DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV,
   and default text-based PDFs to structured Markdown inside this fetch path.
   AnyDoc's PDF path uses its bundled `pdf-inspector` parser; scanned/image-only
   and encrypted PDFs remain explicit failures because OCR is not implicit. An
   explicit `maxPages` request retains bounded `pdftotext`, since AnyDoc 0.1.6
   has no page-range option. There is no separate public extension or hosted
   Firecrawl call.
4. The AnyDoc worker owns native conversion lifetime; `fetcher.ts` owns the
   safe response read, output bound, cancellation/deadline, untrusted-content,
   provenance, and error-mapping layers. AnyDoc's internal Rust resource
   limits complement but do not replace the fetch contract. `web_fetch` accepts
   up to 32,000 requested characters while retaining its hard 32-KB output-byte
   bound; research uses the same shared fetcher limit.
5. Do not add browser/JS rendering or caching until a concrete workflow
   requires them and their separate resource/privacy policies are defined.

## Phase 3 — selective provider additions (deferred)

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
