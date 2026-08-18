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

### Concrete parity finding from local source review (2026-08-02)

The prior `pi-web-access` implementation is not merely another adapter. Its
`openai-search.ts` scans all authenticated OpenAI/Codex models in Pi's model
registry (`resolvePiAuth`), even when a non-OpenAI model is active, and its
auto route in `gemini-search.ts` tries OpenAI when suitable before Exa/Brave.
Its search result also preserves an OpenAI-generated answer alongside sources.
The current `pi-search` router only selects OpenAI/Codex when that provider is
the active model, and intentionally returns evidence without provider answer
synthesis. With OpenRouter/DeepSeek active, pi-search therefore selects Exa
rather than an available OpenAI/Codex registry credential. This is a concrete
UX/quality difference, not a provider-quality benchmark result.

The old extension also provides multi-query search, optional background page
content, curator UI/storage, and configured transient/quota/network fallback.
Those features may explain perceived quality but are separate ownership and
cost decisions; they must be evaluated from actual workflows rather than
copied wholesale.

Evidence: local reference source `/tmp/pi-web-access/openai-search.ts`
(`resolvePiAuth`, `searchWithOpenAI`) and `/tmp/pi-web-access/gemini-search.ts`
(`search`, `searchWithConfiguredRouting`), compared with `src/router.ts` and
`src/openai.ts` in this repository. No new provider requests were made for
this finding.

## Current provider capability matrix

The matrix below is a planning snapshot, not a permanent provider ranking.
Provider documentation, pricing, quotas, and response schemas must be checked
again before an adapter is enabled.

| Provider | Auth and cost posture | Constraint posture | Evidence and social coverage | Decision |
| --- | --- | --- | --- | --- |
| OpenAI/Codex | Pi model registry; model/provider billing | Native Responses search; allowed and blocked domains are supported and post-filtered | Citations and source records; no dedicated X path | Keep as native default; highest correctness priority |
| Gemini | Pi model registry; grounding can be metered | `generateContent` Google Search grounding; no hard domain-filter contract | Grounding chunks plus `groundingSupports`; typed answers require support-linked citations | Keep; active automatic, explicit registry model via `executionModel` |
| xAI web/X | Pi model registry; API key or Pi xAI subscription OAuth; metered tool and token usage | Web filters; X handle/date/media options; no web-domain filters on X | Structured all-source and inline citations; xAI X is the semantic/model-mediated X path | Keep explicit cross-provider; live OAuth/API smoke remains open |
| Brave | API key; quota and paid usage must be explicit | Freshness and domain operators, with post-filtering | URL, title, snippet, publication metadata; no reliable dedicated X path | Keep as controlled general direct provider |
| Exa | API key; usage-based and reports cost | Domains and published-date filters | Highlights, text, score, publication date, cost metadata; no dedicated X path | Keep automatic non-native path |
| Parallel | API key; metered and objective-oriented | Include/exclude domain source policies and lower publication-date bound; upper date bound remains unsupported | URL, title, excerpts, dates, search ID; no reliable dedicated X path | Keep explicit and specialized |
| Perplexity Search API | Bearer key; predictable per-request pricing | Include/exclude domains, path prefixes, and exact publication/update dates | Ranked URLs, snippets, dates, request ID; no dedicated X path | **First candidate** if a new hard-filter provider is wanted |
| Anthropic native web search | API key/model; search-use and token charges | `max_uses` plus allowed or blocked domains, but not both; no native date filter | Strong URL/title/cited-text citations; no dedicated X path | Conditional candidate after auth/evidence review |
| SearXNG | Self-hosted endpoint; no provider billing | Engine-dependent operators and freshness; must validate returned hosts | JSON URL/title/content; no stable X guarantee | Optional privacy/keyless adapter, never a universal fallback |
| Tavily | Bearer key; credits per search with a free allowance | Include/exclude domains and broad date ranges | URL/title/content and optional raw content; no dedicated X path | Defer due to overlap |
| Claude bridge / DuckDuckGo scrape | CLI/subscription or unofficial scraping | No stable structured constraint contract | Opaque synthesis or fragile scraped provenance | Do not add to core |

The current shipped set already covers native grounding, keyword search,
semantic retrieval, objective retrieval, and dedicated X retrieval. Perplexity
is the only reviewed candidate with a clearly distinct combination of
structured evidence plus hard domain/date controls. Anthropic is attractive for
citation quality but overlaps native model-mediated search and has search-use
billing. SearXNG is useful for self-hosting/privacy, not for universal
coverage. Tavily, a Claude bridge, and DuckDuckGo do not justify core
complexity yet.

## Current pricing and observed behavior

Pricing is account-, tier-, mode-, and model-dependent. These are the current
official published rates checked during this review, not permanent defaults:

| Provider/path | Published direct-search price and allowance | Operational implication |
| --- | --- | --- |
| Brave Search API | $5 / 1,000 requests with $5 monthly credits automatically applied; actual plan headers are authoritative | Our account returned 1 request/second and 2,000/month. It was the fastest of the same-query live comparison (about 594ms) and is the cost-controlled general path. |
| Exa Search API | $7 / 1,000 searches (up to 10 results), $1 / 1,000 additional results; official pricing currently says $20 new-account credits and $10 monthly Free Tier credits | A live five-result constrained search passed in about 1.7s and reported $0.007. It returns semantic/highlight evidence, but this review has not established a relevance win across a task corpus. |
| Parallel Search API | `turbo` $1 / 1,000 requests, `basic`/`advanced` $5 / 1,000 requests for the default 10 results; marketing pricing currently says up to 5,000 requests/month free and $5 monthly credits | Official docs position turbo for low-cost/high-volume search, basic for most agents, and advanced for higher quality. Our current adapter uses advanced for `auto`, so it has not yet tested the $0.001 turbo path. One advanced live call passed in about 4.0s. |
| Gemini Google Search grounding | Current Gemini pricing table lists 5,000 free grounding queries/month on the paid tier, then $14 / 1,000 queries; model input/output tokens are priced separately, and one request may issue multiple Google queries | The grounding allowance does not include token charges. Current Gemini 3.x free tier marks Google Search grounding unavailable. It is native to an active Gemini model, not a transparent search backend for an OpenRouter DeepSeek call. |
| Tavily Search | 1,000 free credits/month; basic search costs 1 credit and advanced costs 2; pay-as-you-go is $0.008/credit | More expensive than the current Brave/Exa/Parallel search rates for ordinary search; not a current default candidate. |
| Perplexity Search/Agent web search | Current pricing page lists $5 / 1,000 standalone searches and $0.0025 per Agent API web-search invocation, with separate model/tool pricing | Potentially useful for hard date/path/domain controls, but endpoint semantics and all-in cost need a dedicated adapter audit before comparison. |

The same query was run once through Brave, Exa, and Parallel using the current
adapters. All returned inspectable official OpenAI documentation, but this is
only a smoke comparison: it does not establish semantic relevance, freshness,
or general quality. Automatic provider preference must wait for the task
corpus described in `docs/provider-evaluation.md`.

Sources:

- https://api-dashboard.search.brave.com/documentation/pricing
- https://api-dashboard.search.brave.com/documentation/guides/rate-limiting
- https://exa.ai/pricing?tab=api
- https://docs.parallel.ai/getting-started/pricing
- https://docs.parallel.ai/search/modes
- https://ai.google.dev/gemini-api/docs/pricing
- https://docs.tavily.com/documentation/api-credits
- https://docs.perplexity.ai/docs/getting-started/pricing

## Current official capability notes

These current provider documents refine, but do not replace, the matrix above:

- OpenAI documents fast non-reasoning search, agentic reasoning search, and
  deep-research workflows. The adapter should preserve inspectable search calls
  and citations while leaving answer synthesis to the active model.
- xAI `x_search` supports keyword, semantic, user, and thread retrieval plus
  handle/date filters and optional image/video understanding. The adapter now
  maps those options through a bounded typed contract; live OAuth/API
  verification remains a separate acceptance gate.
- Exa supports highlights/text, date and category filters, additional queries,
  deep search, and structured outputs. The current adapter covers the stable
  evidence path; richer research options should be evaluated for cost and
  token savings before exposing them.
- Parallel positions objective-oriented, LLM-optimized excerpts and multi-query
  context as its differentiator. Its value should be measured by end-to-end
  context efficiency, not just result count. The adapter now sends the caller's
  provider-neutral result cap through `advanced_settings.max_results` while
  keeping excerpt/context sizing as an explicit Parallel transport setting.
- Perplexity Search returns structured results with snippets, dates, update
  dates, domain filters, and page-content controls, making it the leading
  candidate only for a proven hard-filter or page-context gap.
- Tavily exposes search-depth, time-range, content chunks, and separate
  extraction/crawl APIs. That is useful, but overlaps the local fetch path and
  needs a privacy/cost comparison before adoption.

## X/social access

The shipped package already has explicit xAI X search (`xai-x`) through the xAI
Responses API. Current xAI documentation gives it semantic, keyword, user, and
thread retrieval plus handle/date filters and optional image/video
understanding. The adapter maps those fields and uses Pi's model registry, so
Pi's xAI subscription OAuth can authenticate it when a compatible Grok model is
selected. It is the best current path for model-mediated social context and
citations.

The official X API is complementary, not a replacement. Its Recent Search
endpoint covers recent posts and accepts exact query operators plus bounded
start/end times; Full-Archive Search is a separate access tier. The adapter
currently maps bounded handle/date constraints and returns direct post text,
author metadata, timestamps, and deterministic post URLs. It does not yet own
pagination, dedicated lookup, timelines, or archive access. It introduces a
separate bearer credential and direct usage billing.

Keep the official X API as an explicit provider with a separate cost and
credential policy. Keep social/X as a capability declared by a provider, not an
automatic fallback. The current adapter has stable source URLs, inspectable
provenance, bounded recent-search requests, and deterministic fixtures;
pagination, lookup, timelines, and archive access remain open additions.

## Applied

- The package already borrows the direct SSRF/redirect structure from
  `pi-web-access` with attribution in `THIRD_PARTY_NOTICES.md`.
- The current contracts and router remain authoritative. Reference code may
  inform adapters, parsing, credential resolution, and extraction, but not
  silently add fallback, fan-out, synthesis, or telemetry.
- All reviewed codebases with a declared license are MIT-licensed. Preserve
  notices when copying implementation code.

## Findings — local document conversion

- `firecrawl/anydoc` is a separate local Rust/N-API document converter, not the
  hosted Firecrawl web service. The Node package `@firecrawl/anydoc@0.1.6`
  supports DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV, and PDF,
  with content-based detection, GitHub-Flavored Markdown, and an optional
  structured document model carrying tables, notes, links, and embedded assets.
- It requires Node 20+, ships platform-specific native packages, and is MIT
  licensed. The current Apple Silicon platform has a matching native package.
  Conversion is local and does not require a service, API key, OCR model, or
  network call. The repository is Rust-based and includes fuzz targets,
  malformed/encrypted fixtures, and fixed resource limits for archive entries,
  decompression, XML depth/nodes, expansion, records, and retained assets.
- A temporary package smoke converted representative DOCX, PDF, and CSV inputs
  and exposed a DOCX document model successfully. PDF output is structured
  Markdown through `pdf-inspector`; scanned/image-only PDFs remain unsupported
  without OCR. The Node API accepts full in-memory bytes or a path, returns a
  complete string/document, and exposes coded conversion errors, but does not
  expose the fetcher's caller cancellation or output/page controls.

## Applied

- `anydoc` is integrated as the local document/PDF-conversion backend for the
  existing `web_fetch` operation, not as a separate extension or package
  rename. Default text-based PDFs now use its structured `pdf-inspector` path;
  explicit page-bounded requests retain `pdftotext` because the Node API has no
  page-range control.
- Keep the existing safe HTTP byte read, provenance, untrusted-content fence,
  output bounds, cancellation, and error normalization around the converter.
  Hosted Firecrawl/Jina/TinyFish remote extraction remains deferred.

## Open Questions

- The official X API offers stable post URLs, text, timestamps, query
  operators, request limits, and explicit billing; its bounded recent-search
  adapter is shipped, while lookup/timeline/archive expansion remains gated on
  a concrete workflow.
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
- https://platform.openai.com/docs/guides/tools-web-search
- https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
- https://ai.google.dev/gemini-api/docs/google-search
- https://docs.x.ai/developers/tools/web-search
- https://docs.x.ai/developers/tools/x-search
- https://docs.x.ai/developers/tools/citations
- https://ai.google.dev/gemini-api/docs/interactions-overview
- https://docs.x.com/x-api/posts/search/introduction
- https://docs.x.com/x-api/posts/search/quickstart/full-archive-search
- https://docs.x.com/x-api/getting-started/pricing
- https://docs.x.com/x-api/fundamentals/post-cap
- https://docs.x.com/x-api/fundamentals/rate-limits
- https://docs.perplexity.ai/api-reference/search-post
- https://docs.perplexity.ai/docs/search/filters/domain-filter
- https://docs.perplexity.ai/docs/search/filters/date-time-filters
- https://docs.tavily.com/documentation/api-reference/endpoint/search
- https://docs.searxng.org/dev/search_api.html
- https://docs.z.ai/api-reference/tools/web-search
- https://duckduckgo.com/duckduckgo-help-pages/results/sources
- https://github.com/firecrawl/anydoc
- https://github.com/firecrawl/anydoc/blob/main/node/README.md
- https://www.npmjs.com/package/@firecrawl/anydoc
