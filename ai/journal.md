# Journal

Append-only factual history for recovery. Current state belongs in `brief.md`;
durable rationale belongs in `decisions.md`.

## 2026-08-01

- Audited the implemented search and fetch paths. The tracked implementation
  plan marks contracts, routing, direct fetch, provider adapters, research,
  and OpenAI stability gates complete.
- Fixed and verified five boundary issues: cancellable OpenAI error-body reads,
  semantic-mode routing, Brave trailing-dot exclusions, overlong Brave URLs,
  and canonical YouTube provenance.
- Created the public repository `nijaru/pi-search`, then removed the mistaken
  semver release and tag. The package is intentionally unversioned and is
  installed from the Git repository.
- Verified a fresh Pi package install and direct registration of
  `web_search`, `web_fetch`, and `web_research`.
- Researched reference extensions: `pi-web-access`, `pi-web-providers`,
  `pi-search-hub`, `pi-native-search`, `pi-simple-web-tools`, `pi-web`, and
  `pi-deep-research`. Consolidated findings in
  `ai/research/provider-landscape.md`.
- Initialized `.tasks/` with a planning parent and four bounded research and
  design tasks.
- Completed the provider, fetch, and live-smoke research tasks. The resulting
  matrix recommends contract cleanup first, Perplexity as the first possible
  new adapter, SearXNG only for an explicit self-hosted requirement, and no
  new social adapter beyond xAI X yet.
- The fetch audit found no need for browser rendering or caching in the default
  path. It identified a shared result-cleanup/URL-identity gap, Markdown
  content-negotiation metadata work, and the need for an explicit live-smoke
  runner that never runs from the offline test command.
- Implemented and pushed `a1f51e1`: shared search-result cleanup and URL
  identity now run after provider parsing, research fetches deduplicate using
  that identity, opaque provider answers are excluded from `web_search`, and
  the unversioned package no longer sends a versioned user-agent string.
  Verification: 111 tests and 256 assertions pass with TypeScript checking.
- Implemented and pushed `8b0e25a`: direct fetch now prefers Markdown via
  content negotiation and preserves `text/markdown` responses as bounded,
  untrusted Markdown with explicit extraction metadata. Verification: 112
  tests and 258 assertions pass with TypeScript checking.
- Implemented and pushed `dfbac88`: added an explicit, single-provider live
  smoke runner and operator documentation. It requires separate opt-in,
  credentials, and metered acknowledgement; dry-run and missing-credential
  fail-closed paths were verified without network calls.
- Revalidated current official Perplexity Search and SearXNG API docs. Kept
  both as explicit future candidates rather than adding overlap or endpoint
  complexity without a concrete requirement. Perplexity's extra date/path
  controls are not represented by the current public request contract.
- Review of the clean `fa7a60e` tree concluded that pi-search is suitable for
  staged use but not yet a sole replacement. Concrete blockers are shared hard
  domain enforcement, header-only auth redaction, correct Codex smoke endpoint,
  request/usage metadata retention, bounded domain inputs, and an explicit
  search-content trust fence.
- The user chose one final runtime, not permanent coexistence. Created P1/P2
  tasks for correctness, live/Pi acceptance, needs inventory, and final
  cutover. Prior deferred features are now hypotheses to validate against our
  actual workflows rather than permanent exclusions.
- Implemented and pushed `60198f4`: the shared cleanup boundary now enforces
  include/exclude domains, domain inputs are bounded by count and aggregate
  bytes, Brave reuses the shared matcher, and Gemini/xAI/OpenAI preserve
  successful header request IDs. OpenAI diagnostics redact header-only bearer
  credentials. Verification: 113 tests and 263 assertions pass with TypeScript.
- Created `ai/research/required-workflows.md`. It keeps native/direct provider
  search, xAI X, evidence cleanup, direct page/PDF/YouTube-caption fetch, and
  bounded research as required. It classifies fan-out, answer synthesis,
  history storage, GitHub cloning, media vision/OCR, browser/remote extraction,
  caching, and extra overlapping providers as deferred or Pi/Bash-owned rather
  than silently requiring parity with `pi-web-access`.
- Fixed and pushed `671f255`: Codex live smoke now uses
  `https://chatgpt.com/backend-api`, guarded by an offline endpoint test.
- Fixed and pushed `18e820c`: provider usage now preserves OpenAI input/output/
  total tokens, research aggregates token/quota observations, and standard
  rate-limit headers propagate through JSON adapters. Search output now has an
  explicit untrusted-data prefix while remaining within the serialized bound.
  Verification: 116 tests and 270 assertions pass with TypeScript.
- Refreshed the installed Git package to `eff97c7` and verified direct
  registration of exactly `web_search`, `web_fetch`, and `web_research`.
  A fresh Pi process returned one structured Codex search result with request
  ID and token usage. Dedicated shell credentials for Gemini, xAI, Brave, Exa,
  and Parallel were absent, so their live smoke rows remain explicitly skipped.
- Removed `npm:pi-web-access` from the active Pi package list. Updated README,
  architecture, implementation plan, brief, and decisions for the sole-owner
  runtime. Existing Pi processes need a restart to observe the cutover.
- The long-term direction was clarified: the current shipped set is a cutover
  baseline, not a permanent provider ceiling. The desired target is a
  best-in-class portfolio by capability, with explicit multi-provider selection
  or future comparison allowed but no hidden fan-out, paid fallback, or opaque
  merged provenance. The next priority order is OpenAI/Codex correctness,
  direct fetch/PDF efficiency, Brave free-mode admission, provider-role
  evaluation, X coverage comparison, then selective provider or browser
  additions. The consolidated plan and task backlog were updated accordingly.
- Implemented and pushed the P1 gates: OpenAI/Codex response-stream failures
  now preserve request/rate metadata and classify broken streams correctly;
  direct plain-text/Markdown/JSON fetches bypass the extraction worker; PDF
  fixtures cover empty output, bounds, diagnostics, and cancellation; and
  Brave free-only mode spaces request starts by one second while retaining
  provider quota observations.
- Current OpenAI web-search documentation was rechecked and the adapter was
  corrected to send both `allowed_domains` and `blocked_domains`; shared
  result cleanup remains authoritative.
- Added and pushed a deterministic provider-role evaluator and an explicit
  official X API recent-search adapter. xAI `x_search` remains the semantic,
  model-mediated social path; the official X adapter provides direct post
  text, IDs, timestamps, query operators, and separate metered credentials.
  X live smoke is credential-gated and currently skipped.
- Closed the selective-provider and dynamic-page evaluation tasks. No open
  tasks remain; Perplexity, SearXNG, browser/remote extraction, and similar
  additions remain conditional on measured workflow gaps.
- A review found that `web_search` serialized the entire normalized response as
  raw JSON into model-visible chat. It now renders bounded readable evidence
  with query, provider, source URLs, titles, excerpts, dates, warnings, and
  compact usage while preserving structured `details` for callers.
- Verified current provider economics from official pages and live calls:
  Brave Search lists $5/1,000 requests with monthly $5 credits; its live
  response exposed a 1-request/second window. Exa lists $7/1,000 searches,
  with $20 initial and $10 monthly free credits; the live adapter reported
  $0.007 for a three-result search. Gemini Search grounding lists 5,000 free
  requests/month then $14/1,000 queries, plus model token charges. These facts
  are not enough to rank relevance, so automatic Exa preference was reverted.
- A fresh Pi smoke exposed a cutover regression: configured Brave was rejected
  unless `PI_SEARCH_BRAVE_FREE_ONLY=1` was set, unlike the previous extension's
  working default. The construction boundary now enables conservative Brave
  free-mode admission by default, keeps one-second request pacing, and reserves
  `PI_SEARCH_BRAVE_FREE_ONLY=0` for deliberate metered opt-in.
- The same UX audit found that a global `PI_SEARCH_ALLOW_METERED=1` gate also
  blocked active Gemini/xAI models and explicitly selected Exa, Parallel, and
  official X providers. Active model selection or an explicit provider hint is
  already user intent, so those redundant gates were removed; credentials and
  strict single-provider routing remain required.
- The user set the active evaluation policy: prioritize total cost for useful
  results over latency, avoid repeated paid measurements, restrict the first
  comparison to Brave, Exa, Parallel, and Gemini, and treat marketing claims
  about free tiers as unverified until docs or account evidence confirms them.
  Exa should be made fully reliable first as the known useful fallback, without
  making its popularity or the previous extension's behavior the default policy.
- Designed and pushed `fd8e4ca`: the search-plane contract now defines
  task-useful typed answers/evidence, registry-driven native resolution, one
  visible bounded fallback, and opt-in safe source enrichment.
- Implemented and pushed `a8dc15f`: OpenAI/Codex, Gemini, and xAI preserve
  bounded cited provider answers; OpenAI/Codex can execute through an
  authenticated Pi registry model while another model is active; automatic
  routing makes at most one visible fallback; and `web_search` can fetch a
  bounded selection of sources through the local safe fetcher. Offline checks
  pass with 145 tests and 349 assertions.
- Refreshed the installed package to `a8dc15f`. A fresh Codex Pi process
  completed a live `web_search` request with concise cited output and no raw
  JSON. A fresh OpenRouter/DeepSeek process failed before tool execution with
  `401 User not found`, so that is an OpenRouter credential/session blocker,
  not a search adapter result. No provider comparison calls were made.
- Reviewer follow-up found and fixed three enrichment edge cases in `32c134f`:
  multibyte source content now obeys byte bounds, failed enrichment counts
  toward the fetch-attempt limit, and cancellation/deadline errors retain
  stable search error codes. Invalid or evidence-only answers are removed at
  shared cleanup. Verification: 148 tests and 356 assertions pass; the
  installed package was refreshed to `32c134f`.
- 2026-08-01: Ran one explicit Exa live smoke only (IANA domain-filtered
  query). It returned three bounded HTTPS sources, no warnings, a request ID,
  and provider-reported cost of $0.007. Updated automatic routing so an active
  OpenAI chat-completions model is treated as non-grounded and falls through
  to registry/native or direct routing instead of failing before the normal
  path. Offline verification remains 148 tests and 357 assertions.
- 2026-08-01: After updating the installed package to `61e71f9`, a fresh Pi
  process with active Codex and explicit `provider: exa` made exactly one
  `web_search` call and returned three concise Markdown source links, with no
  raw JSON. Exa direct and installed tool-path smoke gates now pass; the
  OpenRouter/DeepSeek non-native gate remains blocked by the earlier 401.
- 2026-08-02: Official Gemini and xAI documentation review confirmed their
  web/X search features are model-mediated tools. Added explicit registry-backed
  `executionModel` selection for Gemini, xAI/X, and OpenAI/Codex, with xAI OAuth
  flowing through Pi's model registry. Grounding citations now align with
  Gemini `groundingSupports` and xAI annotations; all encountered sources stay
  evidence. Added typed X handle/date/media options, Exa published-date filters,
  research execution-model propagation, and separate search-query/token usage.
  Unsupported hard constraints are rejected by both routing and adapters, and
  automatic fallback is limited to safe auth/rate-limit/unavailable failures.
  Offline verification: 165 tests / 395 assertions, TypeScript clean, no live
  provider calls made in this pass; Gemini/xAI/X live acceptance remains open.
- 2026-08-02: Committed and pushed the implementation as `9a18341` and the
  context updates as `9806f7c`. The working tree is clean. The installed copy
  intentionally remains at `61e71f9`; refreshing it and restarting Pi is the
  next operational step before testing the new model-mediated paths.
- 2026-08-02: After the installed checkout was refreshed to `78a9af0` and Pi
  was restarted, deliberate live smoke gates passed for active OpenAI/Codex,
  explicit Exa (provider-reported cost `$0.007`), xAI web search with
  `grok-4.5`, xAI X search with `grok-4.5`, and bounded Readability fetch.
  Gemini `gemini-2.5-flash` reached the adapter but returned HTTP 401 because
  direct Google model authentication is not configured. A constrained xAI X
  query completed without parseable citations; evidence-first rejection is
  retained until the raw response or a reproducible no-match contract is
  available. The live xAI response exposed numeric inline-citation labels as
  source titles; `33b8409` drops those labels so rendering falls back to the
  source domain, with offline coverage. The xAI web and X smokes reported
  47,360 and 26,693 total tokens respectively; these were single correctness
  calls, not a comparison, but they confirm that model-mediated xAI search is
  materially metered and should not be retried or made an unbudgeted fallback.
  Verification is 166 tests / 396 assertions; the installed checkout is now
  `33b8409` with its unrelated local `bun.lock` change preserved.
- 2026-08-02: Corrected the Gemini search model policy after review: do not
  use legacy or full Flash/Pro models for search-only grounding. Current
  examples and deterministic execution-model fixtures now use Pi's
  `gemini-flash-lite-latest` alias, which keeps the model choice current and
  cost-oriented; runtime still honors only the active or explicitly selected
  registry model and never substitutes one silently. A corrective live call
  with current `gemini-3.6-flash` also returned HTTP 401, so direct Google
  authentication remains unavailable; no paid Flash or Lite request was made.
- 2026-08-02: After Pi was reloaded, the direct Google
  `gemini-flash-lite-latest` smoke still returned HTTP 401. The shell has a
  `GEMINI_API_KEY` set, distinct from the OpenRouter key; Pi's auth file has no
  Google entry, which is normal for environment-based Google auth. The key is
  therefore present but rejected or not the credential the running Pi process
  resolves. No billable Gemini request was made.
