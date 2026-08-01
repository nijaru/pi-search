# pi-search

A standalone, provider-neutral web search and fetching extension for Pi.

## Status

The cost-controlled core is implemented. The extension exposes exactly three
Pi tools:

- `web_search` — structured evidence with URLs, excerpts, dates, and provider
  provenance.
- `web_fetch` — bounded safe extraction from a selected URL.
- `web_research` — explicit, budgeted sequential search and fetches.

### Search routing

- Active OpenAI Responses and OpenAI Codex Responses models use native search
  first. Native failures are final; they never trigger another provider.
- Active Gemini models use Google Search grounding when
  `PI_SEARCH_ALLOW_METERED=1` permits model-mediated search.
- Active xAI Responses models use xAI web search under the same explicit
  metered opt-in. Select `xai-x` explicitly when the task requires X search.
- Other/local models use Brave only when its free-capacity assertion is
  enabled.
- Exa and Parallel are available only through explicit provider selection and
  `PI_SEARCH_ALLOW_METERED=1`.
- There are no hidden retries, provider fan-out, or paid fallback chains.

All providers normalize into the same evidence-first result shape. Provider
answers are not returned as authoritative summaries.

## Configuration

The extension reads credentials only at construction or through Pi's model
registry; it never logs keys.

```bash
# Non-native/local-model search
export BRAVE_API_KEY=...
export PI_SEARCH_BRAVE_FREE_ONLY=1       # opt into conservative free-mode admission
# Free mode spaces request starts by 1s and honors observed quota headers;
# it does not inspect account billing or guarantee no paid overage.

# Explicit metered providers and non-OpenAI native grounding
export EXA_API_KEY=...
export PARALLEL_API_KEY=...
export PI_SEARCH_ALLOW_METERED=1
```

Gemini and xAI credentials come from the active Pi model's authentication
context. A provider hint such as `provider: "exa"`, `"parallel"`, or
`"xai-x"` is strict and never falls through to another provider.

## Fetch coverage

`web_fetch` owns direct HTTPS/HTTP fetching with SSRF protection, redirect
validation, response limits, cancellation, Markdown content negotiation, local
Readability/Turndown extraction, and untrusted-content fencing. It also supports:

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
