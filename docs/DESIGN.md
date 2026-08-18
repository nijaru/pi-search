# pi-search design

## Public boundary

The extension exposes exactly three Pi tools:

- `web_search` returns a bounded typed provider answer when available plus
  inspectable evidence and provenance, or evidence alone.
- `web_fetch` retrieves bounded content from a selected URL.
- `web_research` runs an explicit, budgeted sequence of searches and optional
  fetches.

There is no separate opaque answer tool, hidden planner, unbounded provider
fan-out, or implicit browser/crawler. Provider answer text remains untrusted
and must cite normalized sources.

## Provider boundary

Adapters receive an explicit `ProviderContext`. Model-mediated adapters use the
active Pi model and model registry supplied by that context; they do not read
Pi auth state globally. Direct providers receive credentials from the
construction boundary.

Shipped search adapters:

| Adapter | Active/default use | Explicit use | Hard constraints |
| --- | --- | --- | --- |
| OpenAI/Codex Responses | Active supported OpenAI model | `openai`/`openai-codex` | Responses APIs only; allowed and blocked domains |
| Gemini grounding | Active Google Gemini model | `gemini` plus optional `executionModel` | No hard domain filter; grounding citations required for typed answers |
| xAI web grounding | Active xAI Responses model | `xai` plus optional `executionModel` | Web domain filters supported |
| xAI X grounding | — | `xai-x` plus optional `executionModel` | Handles, date ranges, image/video options; no web-domain filter |
| Exa | Other/local model with configured key | `exa` | Semantic retrieval, excerpts, and domains |
| Brave | Other/local model when Exa is unavailable; free-mode pacing by default | `brave` | Keyword/fresh/domain filters |
| Parallel | — | `parallel` with configured key | Search objective/excerpts; include/exclude domain policies and lower date bound |
| Official X API | — | `x` with configured bearer token | Bounded recent search with query operators and direct post evidence; dedicated lookup/archive endpoints remain future work |

Explicit provider failures are final. Automatic routing may use one visible
fallback only after an authentication, rate-limit, or unavailable failure that
is known not to have produced a billable result; network, timeout, and
post-dispatch HTTP failures remain final because their effects are uncertain.
There are no adapter retries or hidden provider changes.

## Routing and billing

Normal `web_search` resolves one primary provider and, for automatic routing,
at most one visible fallback:

1. OpenAI Responses or Codex Responses native search when that is the active
   compatible model.
2. For another active model, an authenticated OpenAI/Codex Responses model
   available through Pi's model registry is eligible, preserving built-in
   search without requiring a model switch.
3. Gemini or xAI grounding when that provider is the active model; selecting
   the model is the user's metered-call decision. Explicit `gemini`, `xai`, and
   `xai-x` hints may use a compatible Pi-registry model via `executionModel`;
   `xai-x` remains explicit for X-specific grounding.
4. Exa for other models when `EXA_API_KEY` exists and its hard constraints
   are supported. Exa is selected before Brave because it supplies semantic
   retrieval, highlights, and reported cost.
5. Brave when Exa is unavailable and `BRAVE_API_KEY` exists. It uses
   conservative free-mode admission by default (1 RPS local pacing plus
   observed quota windows); set `PI_SEARCH_BRAVE_FREE_ONLY=0` only when
   `PI_SEARCH_ALLOW_METERED=1` explicitly permits deliberately unpaced,
   configured metered Brave.
6. Parallel and official X API remain explicit until their quality/role
   evaluation justifies default routing.

A primary failure may use one fallback only for authentication, rate-limit,
or unavailable failures known not to have produced a billable result.
Network, timeout, and post-dispatch HTTP failures remain final because their
effects are uncertain. Explicit provider hints, invalid/unsupported/malformed
requests, and cancellation remain final. There are no retry loops, paid
fan-out, or provider comparisons. Provider profile usage and selected execution
model are surfaced when available. A research cost ceiling is rejected when a provider
cannot provide a reliable per-call estimate; this prevents a false guarantee
for native grounding, Exa, and Parallel.

## Native OpenAI stability contract

The OpenAI/Codex adapter is regression-protected separately from the other
adapters:

- OpenAI uses only `openai-responses`; Codex uses only
  `openai-codex-responses`.
- The active model selects the native provider; the adapter then selects one
  authenticated same-provider Responses model from Pi's registry for search.
- Credentials and model headers are resolved for that selected registry model.
- Codex OAuth account headers are derived from the resolved token.
- Responses streaming accepts LF and CRLF SSE, requires a terminal completed
  event, rejects incomplete/truncated streams, and bounds body bytes.
- HTTP errors preserve status, request ID, retry timing, and retryability.
- OpenAI/Codex domain filters are sent as allowed/blocked domains and
  enforced again by shared result cleanup.

This adapter never treats a completion-only or partial response as successful
search evidence.

## Evidence normalization

Every provider returns:

- source URL and hostname;
- optional title, excerpt, publication timestamp, score, and source ID;
- provider identity, executed query, and execution model when available;
- an optional typed, bounded provider answer with source URL citations;
- applied options and explicit unsupported-option warnings; and
- request ID, latency, and provider usage when available.

Answer text is untrusted provider output, not an authoritative summary. Native
citation metadata is retained as inspectable source evidence and citations are
aligned with normalized URLs. Normal tool content is readable and bounded
rather than raw JSON; the full normalized response remains in tool details and
is shown by the expanded Pi renderer.

## Direct fetching and specialty paths

The fetch operation uses pinned direct HTTP transport, manual redirect
validation, DNS/IP SSRF checks, streamed byte limits, one overall deadline,
cancellation, and local extraction. Fetched content is always untrusted data.
`web_search` can opt into bounded enrichment of selected result URLs through
this same fetcher; it never uses an implicit remote extraction service.

- PDF URLs are fetched safely, validated by magic header, and passed to pinned
  local `@firecrawl/anydoc`/`pdf-inspector` conversion for structured Markdown.
  AnyDoc detects scanned/image-only and encrypted PDFs but does not perform OCR.
  An explicit `maxPages` request uses bounded local `pdftotext` because AnyDoc
  0.1.6 has no page-range option; there is no persistent download.
- YouTube URLs are canonicalized to HTTPS video URLs and passed to bounded
  local `yt-dlp` captions-only extraction with `--ignore-config` and
  `--no-playlist`. No media download, frames, or visual analysis.
- Pinned `@firecrawl/anydoc` converts supported DOC/DOCX, PPT/PPTX, XLS/XLSX,
  ODT/ODS/ODP, RTF, EPUB, CSV, and PDF bytes locally inside `web_fetch`; it
  runs in a worker with caller cancellation and remains bounded, untrusted
  content. It is not a hosted Firecrawl integration, separate public tool, or
  package rename.
- Local files, repository work, video frames/downloads, OCR, and browser
  automation remain explicit Bash, `git`, `gh`, `ffmpeg`, or browser workflows.

## Research limits

`web_research` accepts caller-supplied queries, an optional strict provider
hint, and an optional explicit `executionModel` for model-mediated providers.
It selects one provider once, runs searches sequentially, optionally fetches
result URLs in order, counts search/fetch/step limits separately, uses one
deadline, bounds output, and reports partial failures. It performs no query
planning, synthesis, retry, or provider fan-out.

## Runtime ownership

`pi-search` is the sole active web extension. `pi-web-access` remains a source
reference only; its duplicate registration is not part of the runtime. A
future specialty capability may be evaluated for inclusion or assigned to
Pi/Bash, but installing a second overlapping web extension is not the default
solution.
