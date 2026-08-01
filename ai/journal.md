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
- A fresh Pi smoke exposed a cutover regression: configured Brave was rejected
  unless `PI_SEARCH_BRAVE_FREE_ONLY=1` was set, unlike the previous extension's
  working default. The construction boundary now enables conservative Brave
  free-mode admission by default, keeps one-second request pacing, and reserves
  `PI_SEARCH_BRAVE_FREE_ONLY=0` for deliberate metered opt-in.
