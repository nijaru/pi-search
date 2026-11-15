# Provider and spending policy

Provider capabilities, prices, quotas, and API schemas change. Priority is a
predictable routing policy, not a universal quality ranking. Configuration and
the default ordering live in [README](../README.md#search-routing); execution
invariants live in [DESIGN](DESIGN.md).

## Preference and admission

Automatic search first tries the active provider with its existing
authentication and an eligible search model: ChatGPT/Codex uses Codex standalone search, API GPT
uses OpenAI Responses, Gemini uses Google, Grok uses xAI web/X, and supported
Anthropic/Meta models use their matching adapters. A GPT-looking model name
behind an unrelated proxy is not proof of either OpenAI or Codex authentication.

`PI_SEARCH_PROVIDER` pins an installation primary instead. Its optional
`PI_SEARCH_MODEL` pins that backend's registry model. Per-call
`advanced.provider` overrides are strict, including `native` (active-only):
they disable fallback. A per-call execution model requires a concrete provider.

Automatic alternatives prefer dedicated retrieval before other authenticated
native providers. Capability and pure adapter-specific request checks happen
before credentials or network work. Incompatible/unconfigured providers are
skipped; an explicitly pinned primary must support the request.

Off-provider automatic metered or unknown-cost backends require
`PI_SEARCH_ALLOW_METERED=1` or `PI_SEARCH_PREFER_FREE=1`. Without either, only
Brave's conservative free-mode admission participates off-provider.
Prefer-free puts Brave before other alternatives, not before active native
search. The active provider is deliberate authentication selection; an unrelated
cached key/login is not spending permission. Subscription usage is not assumed
free. Brave pacing and observed quota headers do not establish account balance
or guarantee against paid overage.

`PI_SEARCH_FALLBACK_PROVIDERS` replaces the default alternative list with an
ordered allowlist. Its named entries deliberately admit spending, but cannot
enable disabled adapters or manufacture credentials. Missing configured adapters
are skipped; repeated IDs are rejected. An empty value disables alternatives.
The preferred backend is never repeated in its own fallback list.

Only proven safe pre-dispatch failures or explicit auth/rate-limit rejections
may advance to the next provider. A response carrying reported usage, ambiguous
network/timeout failure, cancellation, malformed response, or post-dispatch
failure is final for that query. The first success ends the sequence; no fan-out
or same-provider retry is added. Every executed attempt is visible.

## Shipped backends

| Backend | Automatic role | Authentication |
| --- | --- | --- |
| Codex standalone `alpha/search` | Active ChatGPT/Codex; otherwise admitted native fallback | Pi model registry |
| OpenAI Responses | Active API GPT; otherwise admitted native fallback | Pi model registry; separate API billing |
| Gemini, xAI web/X, Anthropic, Meta | Matching active provider; otherwise admitted native fallback | Pi model registry |
| Exa, DeepSeek | Dedicated metered alternatives | `EXA_API_KEY`, `DEEPSEEK_API_KEY` |
| Brave | Paced/quota-aware alternative; first alternative in prefer-free mode | `BRAVE_API_KEY` |
| Parallel Search | Dedicated metered alternative after Brave | `PARALLEL_API_KEY` |
| Cloudflare gateway | Dedicated metered alternative after Parallel; requires explicit upstream | Account ID and `CLOUDFLARE_API_TOKEN` |
| Official X recent search | Admitted alternative only for social requests | `X_API_BEARER_TOKEN` |
| Parallel Responses, Brave Answers | Explicit primary/allowlist/per-call only; enable gates required | Underlying provider key |

Anthropic subscription request identity is unsupported and rejected before
native dispatch; automatic routing can continue safely. An auth-token exchange
or provider response that has already performed work is not automatically safe
just because its final error says authentication failed.

Other providers earn integration by solving a demonstrated gap, not by filling
out a matrix.

## Direct-provider quality and cost posture (2026-09; DeepSeek pricing 2026-10-17)

This is recorded evidence, not a permanent ranking; providers change pricing
and quality faster than this document. Priorities for provider decisions are
quality first, cost second, latency last.

- **Comparable-tier benchmarks.** The Artificial Analysis Search Index
  (August 2026, independent) ranks Parallel Search (advanced tier) first of
  12 search API products on quality lift over a no-search baseline. Parallel's
  own published evals (July 2026, methodology disclosed) place their turbo
  tier above Exa Instant, Tavily Ultra Fast, Brave, and SerpAPI on
  BrowseComp/HLE/WebWalker/SimpleQA accuracy at lowest latency — vendor-run,
  so weight accordingly, but the independent index agrees on the top tier.
  AIMultiple (May 2026, independent, 100-query LLM-judge methodology) put
  Brave (14.89), Firecrawl, Exa (14.39), and Parallel's agentic tier in one
  statistically tied top band with Tavily meaningfully behind. Comparing
  *comparable tiers*: standard Exa search and Brave's base plan sit in the
  top band with Parallel's search tiers; Parallel's 13.6s Task/pro tier is a
  different product and is not comparable to sub-second search tiers.
- **Current pricing (verified 2026-09 against vendor pages).** Parallel
  Search: `fast`/`turbo` \$1 per 1K, `basic`/`advanced` \$5 per 1K, 5,000 free
  requests/month. Exa: \$7 per 1K search with contents for the first 10
  results bundled since March 2026 (highlights we already request are now
  included); Deep Search \$12–15 per 1K. Brave: \$5 per 1K with \$5 monthly free
  credits. Perplexity Sonar Pro is token-metered (\$3/\$15 per 1M) plus
  per-request search fees. DeepSeek Search is \$0.75 per 1K successful requests
  (verified 2026-10-17 against DeepSeek's pricing page).
- **No local quality smoke.** Published independent evaluations measure
  quality better than a handful of local corpus calls could; a local smoke run
  cannot meaningfully measure answer quality. Live provider checks are for
  contract/correctness validation only (request mapping, normalization,
  constraint enforcement, usage reporting), using `docs/live-smoke.md`.
  Provider-quality decisions defer to current published benchmarks, and this
  section is refreshed when they change materially.

## Cloudflare gateway posture (2026-10-07)

The [Web Search API](https://developers.cloudflare.com/web-search/how-to-use/)
is a billing/auth gateway, not a new Cloudflare search index. Its published
limits are 1,024-character queries and 10 results, with no domain/date/social
filters. The adapter rejects unsupported controls, requires an explicit
upstream, and preserves upstream provenance in results and tool output.

[Advertised list prices](https://developers.cloudflare.com/web-search/providers/)
per 1,000 requests are Ceramic $0.25, Exa $7, and Linkup $5. Gateway credits
have no advertised markup; BYOK billing follows the upstream agreement.
Actual billed cost is not inferred, so estimated batch spending thresholds are rejected when no per-request estimate is available.
An explicit BYOK alias prevents missing-key fallback to credits.

Keep direct Exa as the direct-search default: it has richer filtering than the
gateway and there is no representative Ceramic quality comparison here.
Ceramic operates its own independent index, with long descriptions intended
for agent grounding; lower price does not make it keyword-only or prove
quality parity. Its [terms §7(n)–(p)](https://www.ceramic.ai/terms-of-service)
restrict retaining and independently extracting results. Saved/exportable Pi
transcripts appear to need contractual permission. This is an unresolved
contractual concern, not a legal determination. Provider-side ZDR does not
grant user retention rights; Cloudflare's launch announcement and provider
table also disagree on Exa's ZDR status.

## DeepSeek Search posture (2026-10-17)

DeepSeek exposes two distinct web capabilities. The standalone Search API
(`POST https://api.deepseek.com/v1/tools/search`) returns structured ranked
results with `title`, `url`, `snippet`, a 600–800 character `summary`, an
optional publication `date`, `authority`, and a 0–3 `rerank_score`. It accepts
`count` 1–50, `need_content`, `ori_question`, `localization`, and documented
operators: `site:`, `-site:`, `lang:`, `after:`, `before:`, quoted phrases, and
term exclusions. Queries are capped at 128 characters, including operators.
Pricing is $0.75 per 1K successful requests; the Fetch API is priced the same
but is not integrated because local `web_fetch` already covers bounded
extraction without a per-request fee. Server-side tool calls made through
DeepSeek Harness, Claude Code, or Codex are free until 2026-11-01, after which
the same per-request rate applies.

The Responses API also supports a server-side `web_search` tool, but only for
`deepseek-v4-pro`. Pi's model catalog exposes DeepSeek solely as
`openai-completions`, so `selectModelExecution` cannot resolve a
`deepseek`/`openai-responses` execution model. Registering a model-mediated
adapter anyway would mean sending a Responses request from a chat-completions
model record, which the routing contracts exist to prevent. The direct Search
API also fits this package's evidence-first contract better: it returns
structured sources rather than an answer whose citations would have to become
results. Native DeepSeek grounding can be added later if Pi's catalog exposes
a Responses-API DeepSeek model.

The adapter uses the direct-provider credential path (`DEEPSEEK_API_KEY`),
from the environment or the user credential-command file described in
[Configuration](../README.md#configuration). A DeepSeek login stored only in
Pi's model registry does not register it.

## Search constraints

Unsupported hard constraints are rejected or surfaced:

- OpenAI Responses and Codex `alpha/search` accept allowed and blocked domain
  filters; the shared cleanup boundary still enforces returned evidence.
  Their native context size, location, live-access, and content-type controls
  are exposed only when the selected adapter supports them.
- Gemini grounding has no hard domain-filter contract.
- xAI web search supports allowed/excluded domains; xAI X search supports
  bounded handles, ISO date ranges, and opt-in image/video understanding.
- Anthropic web search supports allowed or blocked domains (not both) and
  user location; tool-result error codes surface instead of empty evidence.
- Meta web search is Responses-compatible but domain, date, social, context,
  location, and content-type controls are unverified, so the adapter rejects
  them and the router only selects Meta for unconstrained queries.
- Parallel Search supports include/exclude domain source policies and a lower
  publication-date bound through `advanced_settings.source_policy`; it does not
  support both include and exclude lists together, an upper date bound, or
  exact timestamp lower bounds.
  Its GA mode tiers are `turbo`, `fast` (the recommended agent default this
  adapter sends for `auto`), `basic`, and `advanced`.
- Exa applies domain and published-date filters; Brave applies domain filters
  and returns normalized evidence.
- DeepSeek accepts domain and publication-date constraints only as documented
  query operators (`site:`, `-site:`, `after:`, `before:`). The adapter widens
  day-granularity bounds by one day so the requested inclusive range is
  contained, warns when a time-of-day bound is present, and post-filters
  results with a known date to the exact inclusive range; results without a
  date are returned with a partial-results warning. Social, media, location,
  context-size, token-budget, and live-access controls are rejected, and a
  composed query over 128 characters is rejected before dispatch.
- Official X recent search maps bounded date ranges and handle operators; it
  does not provide provider-side image/video understanding.

Freshness and keyword modes are retrieval hints for model-mediated or semantic
providers. They produce an explicit warning when the provider cannot guarantee
the requested ranking semantics.

## Candidate providers under evaluation

No candidate below is installed or selected automatically. A new adapter must
first have deterministic request/normalization/error fixtures, an explicit
credential and billing policy, stable inspectable source URLs, and a
credential-gated smoke case.

| Candidate | Why it may earn a slot | Why it is not enabled yet |
| --- | --- | --- |
| Perplexity Search API | Structured results with hard domain, path, and date filters | Adds another metered direct provider; overlap and current schema need a fixture/live audit |
| SearXNG | Self-hosted, privacy-oriented, non-metered search | Engine capabilities and freshness vary; endpoint configuration and SSRF policy need explicit design |
| Mistral web search | Responses-adjacent grounding for Mistral models | Agents/Conversations API shape differs from the non-streaming grounding flow; needs a dedicated adapter and fixture audit |
| Tavily | Simple API, raw content option, predictable credits | Overlaps Brave/Exa/Perplexity and has no dedicated X path |
| Z.AI / Claude bridge / DuckDuckGo | Possible native or keyless coverage | Current provenance, auth, or scraping contracts are not strong enough for the core |

### Synthesis providers (opt-in only, not enabled by default)

Both adapters are implemented and ship disabled. Their enable gates admit
registration; credentials are still required at execution. They require a named
primary/allowlist or `advanced.provider` and never enter auto discovery or the
`native` alias. Default search still returns evidence only; these backends may
perform billed synthesis internally even when the answer is not returned.

| Provider | Position and rationale |
| --- | --- |
| Parallel Responses (`parallel-responses`) | Implemented behind `PI_SEARCH_ENABLE_PARALLEL_RESPONSES=1`. Maps `searchContextSize` onto the reasoning tier (low/medium/high, default medium; $10–$250 per 1K). Grounded answers arrive as `url_citation` annotations with character spans; results are the cited sources. Not enabled by default: the calling agent already has cheap evidence search (native grounding plus Exa/Brave/Parallel) and `web_fetch`, and synthesizes answers from inspectable evidence at model cost. |
| Brave Answers (`brave-answers`) | Implemented behind `PI_SEARCH_ENABLE_BRAVE_ANSWERS=1`. Streaming chat-completions with inline citation tags; usage costs are parsed from the `<usage>` tag so per-call cost is reported. Metered $4 per 1K plus $5 per 1M tokens, billed separately from the `BRAVE_API_KEY` free-mode admission that governs Brave search. Requires a Brave plan that includes AI Answers — a Free plan key returns `OPTION_NOT_IN_PLAN` on every request, and the adapter surfaces that detail from Brave's `ErrorResponse`. Research mode is deliberately not exposed in v1: the agent's own `web_research` orchestration covers multi-step depth. |

Per-provider research previously recommended Perplexity as the first
addition if hard filters are materially needed; that position is now
second to the synthesis position above — hard filters on a metered
direct provider must beat what the agent does with native grounding
plus `web_fetch` before earning a slot. SearXNG should be an explicitly
configured self-hosted option, never a hidden fallback. Dedicated X
remains an xAI capability; a general provider returning `x.com` links
is not equivalent.

## Transient failures

There are no same-provider retries. Authentication, rate-limit, and
unavailable failures known not to have produced a billable result may consume
the next admitted candidate in the ordered search plan. Network, timeout, and
post-dispatch HTTP failures remain final because their effects are uncertain.
Invalid requests fail at the tool boundary. Unsupported constraints are checked
before dispatch; explicit providers never reroute around them. Malformed
responses and cancellation are final. Failures remain visible with stable provider,
status, request ID, retry timing, and retryability fields. A caller may retry
as a new tool call.

## Extension ownership

The extension owns:

- provider-neutral search routing and evidence normalization;
- model-registry authentication boundaries;
- direct provider HTTP, bounded responses, cancellation, and error metadata;
- safe direct HTML/text fetching and local AnyDoc document/PDF conversion;
- free FxTwitter retrieval for public X URLs, with a persistent direct-only
  opt-out, and explicitly authorized X reads in the user's existing browser;
- explicit page-bounded PDF extraction through local `pdftotext` when the
  caller requests `maxPages`;
- remote YouTube caption extraction through bounded local `yt-dlp`; and
- explicit bounded research orchestration.

It does not own:

- local repository/filesystem operations (`read`, Bash, `git`, `gh`);
- general browser automation or arbitrary JS-only page execution (the bounded,
  explicitly authorized X reader is the sole browser exception);
- video downloads, frames, OCR, or visual analysis (`yt-dlp`, `ffmpeg`, vision
  workflows); or
- implicit cloning, persistent search storage, or opaque answer synthesis.
  Typed provider answers may be returned when the backend supplies grounded
  citations; they remain untrusted evidence.

## Runtime ownership and cutover

`pi-search` is the sole active web extension. `pi-web-access` is a source
reference, not a second runtime or a required dependency. Its old configuration
may remain on disk but has no effect when the package is not installed; an
already-running Pi process must restart after package-list changes.

Acceptance gates:

1. OpenAI/Codex fixture and live smoke paths remain green.
2. Each added adapter has deterministic offline request/normalization/error
   tests.
3. No provider hint can silently select a different provider.
4. `bun run check` and `git diff --check` pass.
5. Live calls are credential-gated and run only as an explicit smoke test.
