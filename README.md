# pi-search

A standalone, provider-neutral web search and fetching extension for Pi.

## Status

The cost-controlled core is implemented. The extension exposes exactly three
Pi tools:

- `web_search` — a bounded grounded answer when available, plus structured
  evidence with URLs, excerpts, dates, and provider provenance.
- `web_fetch` — bounded safe extraction from a selected URL.
- `web_research` — explicit, budgeted sequential search and fetches.

### Search routing

- Active OpenAI Responses and OpenAI Codex Responses models use native search
  first. With another active model, an authenticated OpenAI/Codex Responses
  model in Pi's registry can provide the built-in search path without a model
  switch.
- Active Gemini models use Google Search grounding automatically.
- Active xAI Responses models use xAI web search automatically; select `xai-x`
  explicitly when the task requires X search.
- Other/local models use configured Exa automatically when `EXA_API_KEY` is
  available; Exa returns semantic results with excerpts and reported usage.
- When Exa is unavailable, configured Brave is the conservative paced
  keyword/fresh path. Parallel and the official X API remain explicit
  providers.
- Automatic routing permits at most one visible fallback after a safe
  authentication, rate-limit, or unavailable failure. Network, timeout, and
  post-dispatch HTTP failures remain final because their effects are uncertain.
  Explicit provider hints never fall through;
  there are no retry loops or provider fan-out.

All providers normalize into the same evidence-first result shape. Provider
answers are typed, cited, bounded, and marked untrusted rather than treated as
authoritative summaries.

## Configuration

The extension reads credentials only at construction or through Pi's model
registry; it never logs keys.

```bash
# Preferred non-native/local-model search
export EXA_API_KEY=...

# Optional last-resort keyword/fresh search
export BRAVE_API_KEY=...
# Configured Brave uses conservative free-mode admission by default:
# request starts are spaced by 1s and observed quota headers are honored.
# This explicit setting is optional; set it to 0 only when deliberately using
# metered Brave with the opt-in below.
export PI_SEARCH_BRAVE_FREE_ONLY=1
# Free mode does not inspect account billing or guarantee no paid overage.

# Explicit secondary providers
export PARALLEL_API_KEY=...
export X_API_BEARER_TOKEN=...         # explicit official X API search
# Optional: to deliberately disable Brave's default free-mode pacing:
# export PI_SEARCH_BRAVE_FREE_ONLY=0
# export PI_SEARCH_ALLOW_METERED=1
```

Gemini and xAI credentials come from Pi's model-registry authentication
context. Active Gemini/xAI models use native search automatically. For
search-only Gemini grounding, prefer Pi's current `gemini-flash-lite-latest`
model alias rather than full Flash/Pro or legacy model IDs. Explicit
`provider: "gemini"`, `"xai"`, or `"xai-x"` can use a compatible registry model
with `executionModel` even when another model is active; this makes model and
billing choice visible. Pi's `/login xai` subscription flow is supported by the
registry for Grok web/X search. A provider hint such as `provider: "exa"`,
`"parallel"`, or `"x"` is strict and never falls through to another provider.
Without a hint, the router selects available native search first, then Exa,
then Brave when the corresponding credentials and hard constraints permit it.
Set `includeContent: true` on `web_search` only when bounded excerpts from
selected source pages are needed; this reuses the safe local fetch path. For
`web_research`, use `executionModel` with an explicit model-mediated `provider`
when a multi-query run should use a specific Gemini, xAI, or OpenAI model.

## Fetch coverage

Tool results use compact readable model content and a compact Pi display;
expanded tool details retain the normalized metadata and source evidence.
Native grounded answers include citations. xAI X search accepts bounded handle,
date-range, and opt-in image/video-understanding constraints. `web_search` can
opt into bounded
fetching of selected result pages with `includeContent`, `contentResults`, and
`contentMaxLength`; fetched pages remain untrusted.
`web_fetch` owns direct HTTPS/HTTP fetching with SSRF protection, redirect
validation, response limits, cancellation, Markdown content negotiation, local
Readability/Turndown extraction, and untrusted-content fencing. It also supports:

- Office and document URLs through pinned local `@firecrawl/anydoc` conversion
  to Markdown: DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, and CSV.
  Conversion is local, runs outside the event loop, and requires no API key or
  hosted Firecrawl service.
- Remote PDFs through bounded local `pdftotext` extraction. Scanned and
  encrypted PDFs fail explicitly; OCR is not implicit.
- YouTube captions through bounded local `yt-dlp` with no playlist, cookie, or
  media download behavior.

Use Bash, `git`, `gh`, `yt-dlp`, `ffmpeg`, or a browser workflow for local
files, repository operations, video downloads/frames, OCR, and JS-only pages.

## Development

```bash
bun install
bun run check
```

Credential-gated live provider checks are separate; see
[`docs/live-smoke.md`](docs/live-smoke.md). They never run from `bun test`.

The design, provider billing policy, and implementation gates are tracked in
[`docs/DESIGN.md`](docs/DESIGN.md),
[`docs/provider-policy.md`](docs/provider-policy.md), and
[`docs/implementation-plan.md`](docs/implementation-plan.md).

`pi-search` is the sole active web extension. Do not install a second web
extension with overlapping tools; the deferred specialty workflows are
intentionally outside this package until a concrete requirement justifies
owning them.

## License

MIT
