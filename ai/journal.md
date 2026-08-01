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
