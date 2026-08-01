# pi-search implementation plan

This is the tracked source of truth for implementation order.

## 0. Contracts and design gate — complete

- Public boundary is `web_search`, `web_fetch`, and `web_research`.
- Model/auth execution context is explicit.
- Provider profiles, capabilities, usage metadata, hard-option reporting, and
  research budgets are defined and tested.
- Direct fetching is local; remote extraction is not implicit.

## 1. Cost-controlled `web_search` — complete

- Native OpenAI/Codex Responses search is the first route for compatible active
  models.
- Brave is available for other/local models only with explicit free-capacity or
  metered policy.
- No native failure falls through to Brave or a paid provider.

## 2. Direct `web_fetch` — complete

- Direct HTTP fetching uses pinned DNS, SSRF and redirect checks, streamed
  byte limits, local Readability/Turndown extraction, one deadline,
  cancellation, and untrusted-content fencing.
- PDF URLs use bounded local `pdftotext`.
- YouTube URLs use bounded local captions-only `yt-dlp`.

## 3. Capability-aware routing — complete

Shipped routing now covers:

- OpenAI Responses and Codex Responses native search;
- Gemini Google Search grounding;
- xAI web grounding and explicit X grounding;
- Brave for free-capacity or explicitly metered non-native use; and
- explicit, metered Exa and Parallel adapters.

Native and direct failures remain visible. There is no hidden retry, fallback,
or provider fan-out.

## 4. Budgeted `web_research` — complete

`web_research` accepts caller-supplied queries, selects one provider once, runs
sequentially, counts searches/fetches/steps, enforces one deadline, bounds
output, and reports partial completion. A cost ceiling is rejected when the
selected provider has no reliable per-call estimate.

## 5. OpenAI stability gate — complete

Before adding the other adapters, the OpenAI/Codex path was hardened with:

- strict Responses API compatibility checks;
- LF and CRLF SSE parsing;
- required terminal completion events;
- rejection of truncated/incomplete streams;
- request ID and retry-after preservation; and
- regression tests for auth, cancellation, malformed responses, HTTP errors,
  and unsupported constraints.

## 6. Additional providers — complete for the current release

- Exa semantic search with highlights, domains, request IDs, and reported cost.
- Parallel Search API objective/excerpt normalization with explicit domain
  limitation.
- Gemini grounding source extraction through Pi model-registry auth.
- xAI web and X grounding through the Responses API.
- Explicit provider schemas and routing tests for local/non-native workflows.

## 7. Next implementation gates — planned, not required for install

The current package is usable, but the audit found four high-value follow-ups
before calling the search surface mature:

1. ✅ Close the evidence-boundary gap in `src/search-tool.ts`: ordinary
   `web_search` no longer forwards an untyped provider `answer` field.
2. ✅ Add a shared conservative result-cleanup and URL-identity module. It
   runs after provider parsing and is reused for research fetch deduplication.
   Raw URLs are preserved when canonicalization changes them; arbitrary query
   parameters are not stripped.
3. ✅ Improve direct fetch content negotiation with `text/markdown` and report
   actual format/extraction metadata. Browser rendering and caching remain out
   of the default path.
4. Add an explicit credential-gated live smoke runner. It must never run from
   `bun test`, infer a provider from available credentials, retry, fan out, or
   print secrets. It should verify bounded inspectable URLs and hard-filter
   behavior where supported.

Only after those gates should a new adapter be considered. Perplexity is the
first candidate because it adds structured evidence plus hard domain/date
filters. SearXNG is optional for a self-hosted/privacy requirement. Anthropic
native search is conditional on auth and citation fit. Tavily, Z.AI, Claude
bridge, and DuckDuckGo remain deferred due to overlap or provenance concerns.

## Deferred / outside ownership

These are intentional boundaries, not missing search-provider implementations:

- Browser automation, crawling, remote extraction, and provider fan-out.
- Video downloads, frames, visual analysis, and OCR. Use Bash, `yt-dlp`,
  `ffmpeg`, or a dedicated vision workflow.
- Local filesystem/repository operations and implicit GitHub cloning. Use
  `read`, Bash, `git`, and `gh`.
- Persistent search history, hidden answer synthesis, and telemetry.
- Live provider calls in the default test suite. Credential-gated smoke tests
  remain an operational release check because they consume quotas or money.
