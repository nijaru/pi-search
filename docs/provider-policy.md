# Provider and replacement policy

This document records the provider-routing and replacement decisions for
`pi-search`. It is deliberately separate from provider adapters: credentials,
prices, quotas, and model capabilities change faster than the normalized
contracts.

## Decisions

### Ordinary search default

The default policy is **native subscription capability first, then configured
free-capacity, with metered providers disabled unless explicitly enabled**:

1. Honor an explicit provider request strictly. Do not switch vendors behind
   `providerHint` or the public `provider` parameter.
2. When the active Pi model is `openai` or `openai-codex`, use that model's
   native Responses `web_search` capability first. Do not fall back to Exa or
   another paid provider when native search is unavailable or fails.
3. Satisfy hard capabilities and filters before considering cost.
4. For other models and `auto`, `keyword`, and `fresh`, use Brave when
   `BRAVE_API_KEY` is configured and `PI_SEARCH_BRAVE_FREE_ONLY=1` explicitly
   asserts that calls are covered by free capacity. Observed quota windows
   still stop calls when a known finite window is exhausted.
5. `PI_SEARCH_ALLOW_METERED=1` explicitly enables configured metered providers,
   including Brave and Exa. A known Brave quota failure does not silently turn
   into an Exa request.
6. Use Parallel only for an explicit multi-hop/deep-research request.
7. Use Gemini grounding only when a synthesized, Google-grounded answer is
   explicitly requested.
8. Use xAI `x_search` only for an explicit social/X request.

The runtime supports these policy names internally. The extension defaults to
`free-only` because provider credits, subscription allowances, and Brave's
account quota are not stable provider capabilities:

```ts
"free-only" | "prefer-free" | "allow-configured-metered"
```

A quota or rate-limit failure is visible to the caller. It does not silently
turn into a paid request. Every attempted call remains visible in usage and
warnings; there are no automatic retries.

The current slice includes native OpenAI/Codex routing, Brave keyword/fresh
search, and Exa semantic/keyword search behind the metered switch. The
selector runs at tool execution time so it sees the active Pi model. A native
OpenAI/Codex failure is visible; it never spends Exa capacity as an implicit
fallback.

### Transient failures

Start with **zero automatic retries**. A retry is another provider call and may
be another charge. Later, a router may allow at most one same-provider retry
when all of these are true:

- the error is network, 408, 425, 429, or 5xx;
- the caller has not canceled;
- the overall deadline and provider-call budget still allow it;
- the billing policy permits the additional call; and
- `Retry-After` or provider reset headers fit within the deadline.

Never retry authentication, invalid requests, unsupported hard filters,
malformed responses, extraction errors, or cancellation. Never retry a failed
provider by silently switching to another paid provider.

Public tool failures use generic stable codes (`WEB_SEARCH_RATE_LIMIT`,
`WEB_SEARCH_AUTH`, `WEB_SEARCH_TIMEOUT`, and so on). Provider identity,
status, retryability, request ID, and rate-limit metadata remain in internal
or structured details where the Pi runtime permits them.

### Provider comparison

| Provider | Distinct role | Evidence and constraints | Cost / quota posture | Authentication |
| --- | --- | --- | --- | --- |
| OpenAI/Codex native search | First choice when the active Pi model is OpenAI or Codex | Responses `web_search` returns URL citations and optional source metadata. Include-domain filters are supported; excluded domains and publication-date bounds are rejected rather than approximated. Native response text is only returned when `wantAnswer` is requested. | Uses the active model's subscription or API billing. No Exa fallback is performed on failure. | Pi model registry execution context; never read auth globally |
| Brave | Keyword, fresh, low-latency default when configured free capacity exists | Direct URLs, titles, snippets, a bounded freshness hint, and domain post-filtering; publication-date bounds are rejected; no provider answer required | Account quota is authoritative. A user's observed free-tier constraint may be 1 request/second and 2,000/month; do not hard-code those values. Parse rate headers and stop when a known finite window is exhausted. | `BRAVE_API_KEY` / explicit credential source |
| Exa | Semantic and technical retrieval | Direct results, dates, IDs, scores, highlights/text, domain and date filters; request bounded highlights/text when evidence is required | Current docs price base Search per request/result tier and charge content fields per result. Requesting highlights improves evidence but has a measurable cost. | `EXA_API_KEY` through explicit adapter construction |
| Parallel | Explicit multi-hop and deep research | Search modes are `turbo`, `basic`, and `advanced`; advanced is the documented default and is aimed at multi-hop quality. Source policy and date/domain controls must be mapped from current API fields, not guessed. | Official docs describe approximately 200ms/$1 per 1,000 for turbo, approximately 1s/$5 per 1,000 for basic, and approximately 3s/$5 per 1,000 for advanced. Treat prices as a live-provider value. | `PARALLEL_API_KEY` through explicit adapter construction |
| Gemini grounding | Explicit model-mediated Google-grounded answer | Returns generated text with annotations and Google-search call/result steps. It can execute multiple searches per request. The documented Google Search grounding surface does not provide the same hard domain/date controls as direct search APIs. | Gemini 3 bills per search query the model executes; older Gemini grounding versions bill per prompt. A single request can trigger multiple billable queries. | Pi model registry execution context; never read auth globally |
| xAI/X | Explicit social/X retrieval | `x_search` supports keyword/semantic/user/thread work, handle allow/deny lists, ISO date ranges, and optional image/video understanding. It is a Responses/SDK model tool, not a standalone SERP adapter. | Tool and model charges vary with query complexity; per-minute limits return 429. Bound model/tool calls before adding it to research. | Pi model registry or explicit `XAI_API_KEY` execution context |

Verified official references:

- [Exa Search](https://exa.ai/docs/reference/search)
- [Exa pricing](https://exa.ai/pricing?tab=api)
- [Brave pricing](https://api-dashboard.search.brave.com/documentation/pricing)
- [Brave rate limiting](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting)
- [Parallel modes](https://docs.parallel.ai/search/modes)
- [Parallel pricing](https://docs.parallel.ai/getting-started/pricing)
- [Gemini Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [xAI X Search](https://docs.x.ai/developers/tools/x-search)
- [xAI pricing](https://docs.x.ai/developers/pricing)

Prices, quotas, and supported model lists are live configuration inputs, not
hard-coded ranking facts.

## Replacement scope

### Required before removing `pi-web-access`

The replacement acceptance matrix must pass for the workflows actually used:

1. Structured evidence-first `web_search` with one-provider execution.
2. Safe direct HTML/text `web_fetch` with bounded output and explicit raw
   fallback format.
3. Cancellation, deadline, SSRF, redirect, MIME, response-size, and error
   behavior.
4. Local PDF extraction if PDF research is part of the active workflow.
5. Bounded YouTube transcript extraction if video research is active.
6. Explicit X/social search if X research is active.
7. `web_research` if source verification or multi-query research is active.
8. Credential-gated live smoke tests for each enabled provider.
9. A rollback that only re-enables the incumbent extension.

Keep `pi-web-access` installed during this rollout. Its current source supports
`webSearch.enabled: false`, which disables its search/source-check registrations
while retaining specialty fetch/storage tools. The active config is
`$XDG_CONFIG_HOME/pi/web-search.json` when XDG is set (otherwise `~/.pi`); the
current local config disables the incumbent search registrations. A coexistence
smoke test must show only the custom `web_search` plus the incumbent specialty
fetch/storage tools. Re-enable the incumbent search flag for rollback.

`PI_SEARCH_BRAVE_FREE_ONLY=1` is required before default non-native routing
can select Brave. `PI_SEARCH_ALLOW_METERED=1` is required before routing can
select configured metered Brave or Exa capacity. The extension sets neither
switch.

### Intentionally not reproduced

The replacement will not silently reproduce these incumbent behaviors:

- hidden provider fan-out or paid fallback;
- Jina, Firecrawl, Parallel, Gemini, or other remote extraction fallbacks;
- browser-cookie Gemini access;
- curator browser UI and background summary state;
- GitHub cloning as an implicit side effect of URL fetch;
- local video visual analysis and frame extraction in the first fetch path;
- unbounded content persistence or automatic writes to user directories;
- OCR, crawling, or arbitrary browser automation.

### Specialty handlers

- **X:** a future explicit `social` adapter wraps xAI `x_search` through the
  model execution context. Exact X URLs use direct fetch first; a JS shell is
  not silently escalated to a social model call.
- **YouTube:** a future local handler may invoke `yt-dlp` for captions with a
  bounded subprocess, output, and cancellation. The official YouTube caption
  API requires authenticated caption-track access and does not make anonymous
  transcript retrieval a good default. Video frames and visual analysis stay
  separate and opt-in.
- **PDF:** fetch through the same safe transport, then extract locally with
  byte, page, character, and deadline bounds. OCR is deferred. Do not save a
  downloaded PDF into a user directory by default.
- **GitHub:** use Pi's local `git`/`gh` tools for repository exploration. A
  future fetch handler may normalize raw/blob/issue URLs, but it must not clone
  as an implicit network or filesystem side effect.
- **Readable pages:** direct HTTP, MIME validation, Readability/Turndown, then
  bounded output. No remote extraction service is implicit.

## Direct fetch invariants

The direct fetch operation has one lifecycle owner:

```text
validate request
  -> create one caller/deadline signal
  -> resolve and reject non-global addresses
  -> connect using the validated address while retaining host/SNI
  -> follow only manually revalidated redirects
  -> stream and bound response bytes
  -> validate status and MIME
  -> extract locally or return explicitly marked raw HTML
  -> bound output and fence it as untrusted
  -> close body/socket and remove cancellation listeners
```

The transport must not rely only on `Content-Length`, must reject private,
link-local, metadata, multicast, loopback, mapped-IPv4, and mixed DNS answers,
and must not trust proxy behavior in the initial implementation. Redirect
validation repeats DNS/IP checks at every hop. One overall deadline covers DNS,
connect, redirects, body reads, and extraction; a phase must not reset it.

Successful `FetchedContent` records the produced format, extraction method,
redirect count, bytes read, truncation state, and `contentTrust: "untrusted"`.
The model-visible text also fences fetched content as untrusted; metadata alone
is not an instruction boundary.
