# pi-search implementation plan

This is the tracked source of truth for implementation order. `handoff.md` is
local session context and may summarize this file, but it is intentionally
ignored by git.

## 0. Contracts and design gate — complete

- Keep the public boundary at `web_search`, `web_fetch`, and `web_research`.
- Carry model/auth execution context explicitly through `Provider.search`.
- Require provider profiles and preserve actual usage metadata when available.
- Make unsupported search options visible; never silently drop hard filters.
- Define and validate `ResearchBudget` before orchestration.
- Keep direct fetching local; do not add Jina or another remote extractor to
  the first slice.

Exit evidence: `src/contracts.ts` and deterministic tests cover these rules;
`bun run check` passes. The tracked design is in `docs/DESIGN.md`.

## 1. First vertical slice: `web_search` + native OpenAI/Codex + Exa

Implement the Pi registration, native OpenAI/Codex Responses adapter, and Exa
adapter together. When the active Pi model is OpenAI or Codex, native search is
selected strictly and Exa is not an implicit fallback.

Acceptance criteria:

- The initial Step 1 registration was only `web_search`; Step 2 now adds `web_fetch`.
- The tool validates query and result limits, propagates cancellation, and
  applies a bounded timeout.
- The Exa adapter uses `EXA_API_KEY` supplied through its explicit construction
  path and never logs the key.
- Native OpenAI/Codex search uses the active Pi model and model registry auth;
  it never reads credentials globally or falls back to Exa after a failure.
- Results are normalized to evidence fields and the provider-native answer is
  not requested by default.
- Domain/date options are either applied, explicitly warned about, or rejected
  before a request can violate a hard constraint.
- Auth, HTTP, rate-limit, malformed-payload, timeout, and cancellation errors
  map to stable tool-visible failures.
- Offline fixture tests cover normalization and error mapping for both
  providers. Live tests are credential-gated and opt-in.

## 2. Direct `web_fetch` — complete

Implement direct HTTP fetching with a pinned transport and an adapted SSRF and
redirect guard from `pi-web-access`, after preserving its MIT attribution in a
third-party notice. Do not rely on ordinary `fetch()` performing the same DNS
resolution that was validated. Resolve each hostname, reject mixed or
non-global answers, and connect to the validated address while retaining the
original host/SNI. Revalidate every redirect target.

Add local Readability/Turndown extraction, content-type handling, streamed
response-size limits, output truncation metadata, one overall timeout,
cancellation, and untrusted-content fencing. Do not trust proxy resolution in
the first implementation.

Every successful result must mark `FetchedContent.contentTrust` as
`"untrusted"` and report its produced format, extraction method, redirect
count, bytes read, and truncation state at the contract boundary.

If readable extraction fails, return bounded raw HTML with
`fellBackToRaw: true` and `outputFormat: "html"` when raw fallback is allowed.
Otherwise return a stable extraction failure. Do not call a remote extraction
service implicitly.

Tests cover private and link-local targets, IPv4/IPv6 and mapped IPv6,
mixed DNS answers, redirect revalidation and loops, size limits without a
reliable `Content-Length`, non-HTML responses, extraction fallback, output
truncation, cleanup, timeout, and cancellation without requiring network
access by default.

## 3. Capability-aware routing and remaining adapters — in progress

The initial router and Brave adapter are complete. The router uses capability,
billing-policy, quota, and profile metadata, honors native OpenAI/Codex
selection first, and selects one provider for ordinary search. The default is
`free-only`: Brave is eligible only when `PI_SEARCH_BRAVE_FREE_ONLY=1`
asserts free capacity, while metered Brave or Exa requires
`PI_SEARCH_ALLOW_METERED=1`. Quota and transient failures remain visible;
hidden paid fallback is forbidden.

Add Gemini, Parallel, and xAI one at a time. Each adapter gets offline
fixtures, explicit auth/availability behavior, rate-limit metadata, and a
credential-gated live smoke test. Parallel belongs primarily in the research
workflow; xAI and Gemini use the model-registry execution context. Start with
zero automatic retries; later allow at most one bounded same-provider retry
for typed transient failures when the deadline, budget, and billing policy
permit it.

## 4. Budgeted `web_research`

Implement the research tool after `web_search` and `web_fetch` are stable.
Require and validate `ResearchBudget`, use one overall deadline, count every
provider call and step, and require a provider cost estimate whenever a cost
ceiling is requested. Reserve estimates before calls and reconcile them with
reported usage when available. Return warnings for partial completion.
Multi-provider work must be explicit in the request; hidden fan-out and
cross-provider retries are not allowed.

## Deferred

- Public `web_find` or `web_browse` tools.
- Browser automation, crawling, remote extraction services, and provider
  fan-out for ordinary search.
- Local PDF and YouTube transcript handlers until the direct HTML/text fetch
  path and replacement acceptance matrix are stable.
- Video frames, visual analysis, OCR, and implicit GitHub cloning.
- Benchmarking inside this runtime package; use a separate evaluation project.
