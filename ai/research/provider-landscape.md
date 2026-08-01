# Provider and extension landscape

## Findings

### `pi-web-access`

Source: https://github.com/nicobailon/pi-web-access

This is the closest mature end-to-end reference. It has native OpenAI/Codex
search, Brave, Exa, Parallel, Gemini, many additional adapters, provider
precedence tests, live smoke tooling, SSRF/redirect protection, content
extraction, PDF/YouTube/video support, and GitHub handling. Its useful source
locations include `openai-search.ts`, `ssrf-protection.ts`, provider files, and
`test/`.

It also has intentional behavior that does not fit this package: fallback
chains, provider fan-out, synthesized answers, curator UI/storage, GitHub
cloning, and broad video workflows. Reuse bounded adapter, parser, auth, and
safety patterns; do not merge its orchestration wholesale.

### `pi-web-providers`

Source: https://github.com/mavam/pi-web-providers

This is the strongest architecture reference. `src/providers/definition.ts`
models capabilities as typed provider definitions; `provider-resolution.ts` and
`managed-tools.ts` handle provider capability exposure and per-tool mapping;
`provider-runtime.ts` centralizes deadlines, retry policy, and research
execution. It covers many providers and provider-specific option schemas.

Its configurable retries, answers, background contents prefetch, and broad
managed-tool surface are useful optional patterns but must not override this
package's one-provider, evidence-first, explicit-cost policy.

### `pi-search-hub`

Source: https://github.com/ronnieops/pi-search-hub

Its backend registry, credential resolver, cooldown/scoring state, URL
normalization, RRF deduplication, and reader dispatch are useful references.
Its default auto-fallback, reader fallback, caching, and combine mode need
explicit policy gates before adoption because they can create extra calls,
latency, or cost.

### `pi-native-search`

Source: https://github.com/smalibary/pi-native-search

Its small native-provider dispatcher covers Claude bridge, ZAI, Anthropic,
Google, OpenAI, and xAI. It is a useful source for additional native adapters.
It returns mostly formatted text and silently falls back to DuckDuckGo after
native failures, so it is not a contract or policy baseline here.

### `pi-simple-web-tools`

Source: https://github.com/jillesme/pi-simple-web-tools

Its minimal fetch path uses Markdown content negotiation, Readability/Turndown,
PDF extraction, SSRF checks, bounded previews, and a lazy optional Playwright
fallback. Content negotiation and an explicit JS-rendering layer are useful
ideas; this package already has stronger direct transport and subprocess bounds.

### `pi-web`

Source: https://github.com/vihu/pi-web

Its local `ddgr` and `trafilatura` approach offers a keyless fallback with
bounded output and SSRF checks. It trades provider-neutral HTTP control for
external CLI dependencies and is best treated as an optional local adapter.

### `pi-deep-research`

Source: https://github.com/LucianoLupo/pi-deep-research

Its auditable, resumable multi-session workflow records worker evidence,
reachability checks, citation audits, reports, and metrics. It is a reference
for a future advanced research workflow, not a replacement for the current
bounded single-provider `web_research` contract.

## X/social access

The shipped package already has explicit xAI X search (`xai-x`) through the xAI
Responses API. The reviewed extensions do not establish a provider-neutral X
contract. `pi-native-search` covers xAI web search but not a separate X path;
`pi-web-access` and `pi-search-hub` expose many web backends but their listed
provider surfaces do not make X retrieval a stable, evidence-first guarantee.
X support should remain a capability declared by a provider, not a generic
search option. The next task is to verify current provider APIs and live
citation shapes before adding any other social adapter.

## Applied

- The package already borrows the direct SSRF/redirect structure from
  `pi-web-access` with attribution in `THIRD_PARTY_NOTICES.md`.
- The current contracts and router remain authoritative. Reference code may
  inform adapters, parsing, credential resolution, and extraction, but not
  silently add fallback, fan-out, synthesis, or telemetry.
- All reviewed codebases with a declared license are MIT-licensed. Preserve
  notices when copying implementation code.

## Open Questions

- Does any candidate provider offer stable, documented X/social search with
  inspectable URLs, excerpts, request IDs, and bounded cost metadata?
- Should Anthropic native search, Claude bridge, ZAI, SearXNG, DuckDuckGo, or
  Perplexity be added, and what is the cost/auth policy for each?
- Is Markdown content negotiation common enough to add before browser
  rendering, and how should returned HTML/Markdown be normalized without
  losing source fidelity?
- Should an opt-in browser/JS fetch provider live in this package, or remain an
  external workflow as the architecture currently specifies?

## Sources

- https://github.com/nicobailon/pi-web-access
- https://github.com/mavam/pi-web-providers
- https://github.com/ronnieops/pi-search-hub
- https://github.com/smalibary/pi-native-search
- https://github.com/jillesme/pi-simple-web-tools
- https://github.com/vihu/pi-web
- https://github.com/LucianoLupo/pi-deep-research
