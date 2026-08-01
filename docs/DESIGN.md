# pi-search design

## Public boundary

The extension exposes exactly three Pi tools:

- `web_search` returns normalized evidence and provenance.
- `web_fetch` retrieves bounded content from a selected URL.
- `web_research` runs an explicit, budgeted sequence of searches and optional
  fetches.

There is no opaque answer tool, hidden planner, provider fan-out, or implicit
browser/crawler.

## Provider boundary

Adapters receive an explicit `ProviderContext`. Model-mediated adapters use the
active Pi model and model registry supplied by that context; they do not read
Pi auth state globally. Direct providers receive credentials from the
construction boundary.

Shipped search adapters:

| Adapter | Active/default use | Explicit use | Hard constraints |
| --- | --- | --- | --- |
| OpenAI/Codex Responses | Active supported OpenAI model | `openai`/`openai-codex` | Responses APIs only; excluded domains rejected |
| Gemini grounding | Active Google Gemini model | `gemini` | No hard domain filter |
| xAI web grounding | Active xAI Responses model | `xai` | Web domain filters supported |
| xAI X grounding | — | `xai-x` | Social/X search; no web-domain filter |
| Brave | Other/local model when explicitly free-enabled | `brave` | Keyword/fresh/domain filters |
| Exa | — | `exa` with metered opt-in | Semantic retrieval and domains |
| Parallel | — | `parallel` with metered opt-in | Search objective/excerpts; no stable domain filter |

Native/model-mediated failures are final. Direct provider failures are final.
No adapter retries or silently changes providers.

## Routing and billing

Normal `web_search` selects one provider:

1. OpenAI Responses or Codex Responses native search when that is the active
   compatible model.
2. Gemini or xAI grounding only when `PI_SEARCH_ALLOW_METERED=1` explicitly
   permits model-mediated search for those active models.
3. Brave for other models only when `BRAVE_API_KEY` exists and
   `PI_SEARCH_BRAVE_FREE_ONLY=1` asserts free capacity, or when
   `PI_SEARCH_ALLOW_METERED=1` explicitly permits configured metered Brave.
4. No automatic Exa or Parallel selection. They require a provider hint and
   metered opt-in.
5. No fallback after auth, rate-limit, transient, malformed, unsupported, or
   cancellation errors.

Provider profile usage is surfaced when available. A research cost ceiling is
rejected when a provider cannot provide a reliable per-call estimate; this
prevents a false guarantee for native grounding, Exa, and Parallel.

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
- Unsupported excluded-domain filters fail before network access.

This adapter never treats a completion-only or partial response as successful
search evidence.

## Evidence normalization

Every provider returns:

- source URL and hostname;
- optional title, excerpt, publication timestamp, score, and source ID;
- provider identity and executed query;
- applied options and explicit unsupported-option warnings;
- request ID, latency, and provider usage when available.

Model-generated answer text is discarded at the public search boundary. Native
citation metadata is retained as inspectable source evidence.

## Direct fetching and specialty paths

The fetch operation uses pinned direct HTTP transport, manual redirect
validation, DNS/IP SSRF checks, streamed byte limits, one overall deadline,
cancellation, and local extraction. Fetched content is always untrusted data.

- PDF URLs are fetched safely, validated by magic header, passed to bounded
  local `pdftotext`, and cleaned up. No OCR or persistent download.
- YouTube URLs are canonicalized to HTTPS video URLs and passed to bounded
  local `yt-dlp` captions-only extraction with `--ignore-config`, `--no-netrc`,
  and `--no-playlist`. No media download, frames, or visual analysis.
- Local files, repository work, video frames/downloads, OCR, and browser
  automation remain explicit Bash, `git`, `gh`, `ffmpeg`, or browser workflows.

## Research limits

`web_research` accepts caller-supplied queries and an optional strict provider
hint. It selects one provider once, runs searches sequentially, optionally
fetches result URLs in order, counts search/fetch/step limits separately, uses
one deadline, bounds output, and reports partial failures. It performs no
query planning, synthesis, retry, or provider fan-out.

## Runtime ownership

`pi-search` is the sole active web extension. `pi-web-access` remains a source
reference only; its duplicate registration is not part of the runtime. A
future specialty capability may be evaluated for inclusion or assigned to
Pi/Bash, but installing a second overlapping web extension is not the default
solution.
