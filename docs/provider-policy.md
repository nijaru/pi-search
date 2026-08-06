# Provider and replacement policy

Provider capabilities, prices, quotas, and API schemas change. This document
records current routing and spending policy, not a permanent provider ranking.

## Ordinary search

The extension selects one primary provider and may make one visible fallback
call for automatic routing:

1. Active OpenAI Responses and Codex Responses models use native OpenAI search.
2. With another active model, an authenticated OpenAI/Codex Responses model in
   Pi's registry is eligible, so built-in search does not require changing the
   active model.
3. Active Google Gemini and xAI Responses models use native grounding
   automatically; selecting that active model is the user's metered-call
   decision. Explicit `gemini`, `xai`, and `xai-x` hints may use a compatible
   Pi-registry model through `executionModel`; `xai-x` is explicit for
   X-specific retrieval.
4. Other/local models use configured Exa automatically when its hard
   constraints are supported. Exa is preferred because it returns semantic
   evidence and highlights.
5. Brave is the last direct path when Exa is unavailable and
   `BRAVE_API_KEY` is configured. The default is conservative free-mode
   admission: local request starts are spaced by one second and observed
   provider quota windows are honored. `PI_SEARCH_BRAVE_FREE_ONLY=0` disables
   that pacing only for deliberate metered use with
   `PI_SEARCH_ALLOW_METERED=1`; neither mode inspects account billing or
   guarantees against paid overage.
6. Parallel and official X API require an explicit provider hint.

An automatic primary failure may use at most one eligible alternative for
authentication, rate-limit, or unavailable errors known not to have produced a
billable result. Network, timeout, and post-dispatch HTTP failures remain
final because their effects are uncertain. The response reports the failed
provider and fallback warning. Explicit provider hints, invalid/unsupported/
malformed requests, and cancellation remain final. There are no retry loops,
hidden fan-out, or provider comparisons.

## Shipped providers

| Provider | Role | Billing/routing policy | Auth |
| --- | --- | --- | --- |
| OpenAI/Codex | Native and registry-available built-in search | Active model first; one authenticated registry model may serve other models | Pi model registry |
| Gemini | Native Google Search grounding for active Gemini; explicit registry model with `executionModel` | Active model is automatic; cross-provider use is explicit and model-selected | Pi model registry, including Pi xAI/Gemini auth |
| xAI | Native web grounding for active xAI Responses; explicit registry model with `executionModel` | Active model is automatic; cross-provider use is explicit and model-selected | Pi model registry, including xAI OAuth |
| xAI X | Explicit social/X grounding with handle/date/media controls | Explicit `xai-x`; no fallback | Pi model registry, including xAI OAuth |
| Brave | Last non-native/local path | Conservative free-mode spacing by default; deliberate unpaced mode is explicit | `BRAVE_API_KEY` |
| Exa | Automatic non-native semantic path | Selected automatically when configured; one visible fallback may use Brave | `EXA_API_KEY` |
| Parallel | Objective-oriented search and excerpts | Explicit `parallel`; no automatic selection | `PARALLEL_API_KEY` |
| Official X API | Bounded recent search; X query operators and direct post evidence | Explicit `x`; no automatic fallback | `X_API_BEARER_TOKEN` |

The word “fallback” for Brave primarily means fallback in model *selection*
when no native provider applies. Automatic routing also permits one visible
alternative after a safe authentication, rate-limit, or unavailable failure;
explicit providers never use this behavior.

## Why both native and direct providers exist

Native grounding is appropriate when the active model already owns a search
capability, especially OpenAI/Codex, Gemini, and xAI. When another model is
active, an already authenticated OpenAI/Codex model in Pi's registry can still
provide the built-in search path; the response identifies that execution
model. Explicit Gemini and xAI hints can use a registry model selected through
`executionModel`, which supports Pi's subscription OAuth without silently
spending it during automatic routing. This avoids forcing a model switch while
keeping credentials inside Pi's registry boundary.

Exa is the automatic semantic option for local and other models because it
returns useful highlights and source evidence. Brave is the cost-controlled
last direct path when Exa is absent; its free-mode admission remains
conservative. Parallel is a useful explicit objective-oriented provider. The
official X API is a separate exact recent-search path; X query operators can
target posts or users, but dedicated lookup and archive endpoints are not
implemented. xAI X remains the semantic, model-mediated path. None of these
direct providers
provides a reliable fixed per-call estimate for every hard research cost
ceiling, so unsupported cost ceilings are rejected before calls.

## Search constraints

Unsupported hard constraints are rejected or surfaced:

- OpenAI/Codex Responses accept allowed and blocked domain filters; the shared
  cleanup boundary still enforces the returned evidence.
- Gemini grounding has no hard domain-filter contract.
- xAI web search supports allowed/excluded domains; xAI X search supports
  bounded handles, ISO date ranges, and opt-in image/video understanding.
- Parallel's stable Search API contract does not expose domain filters.
- Exa applies domain and published-date filters; Brave applies domain filters
  and returns normalized evidence.
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
| Anthropic native web search | Strong citations and native model integration | Search-use plus token billing; model-registry auth and evidence normalization are unverified |
| Tavily | Simple API, raw content option, predictable credits | Overlaps Brave/Exa/Perplexity and has no dedicated X path |
| Z.AI / Claude bridge / DuckDuckGo | Possible native or keyless coverage | Current provenance, auth, or scraping contracts are not strong enough for the core |

Per-provider research recommends Perplexity as the first addition only if hard
filters are materially needed. SearXNG should be an explicitly configured
self-hosted option, never a hidden fallback. Dedicated X remains an xAI
capability; a general provider returning `x.com` links is not equivalent.

## Transient failures

There are no same-provider retries. Authentication, rate-limit, and
unavailable failures known not to have produced a billable result may consume
the single bounded alternative for automatic routing. Network, timeout, and
post-dispatch HTTP failures remain final because their effects are uncertain.
Invalid requests, unsupported filters, malformed responses, and cancellation
are not retried or rerouted. Failures remain visible with stable provider,
status, request ID, retry timing, and retryability fields. A caller may retry
as a new tool call.

## Extension ownership

The extension owns:

- provider-neutral search routing and evidence normalization;
- model-registry authentication boundaries;
- direct provider HTTP, bounded responses, cancellation, and error metadata;
- safe direct HTML/text fetching and local AnyDoc document/PDF conversion;
- explicit page-bounded PDF extraction through local `pdftotext` when the
  caller requests `maxPages`;
- remote YouTube caption extraction through bounded local `yt-dlp`; and
- explicit bounded research orchestration.

It does not own:

- local repository/filesystem operations (`read`, Bash, `git`, `gh`);
- browser automation or JS-only page execution;
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
