# pi-search

A standalone, provider-neutral web search and fetching extension for Pi.

## Install

```sh
pi install npm:@nijaru/pi-search
```

To upgrade an existing install, reinstall an explicit published version
(`pi install npm:@nijaru/pi-search@<version>`) and restart Pi. Pi leaves an
exact version pin in its extension settings unchanged during `pi update`.

## Status

The cost-controlled core is implemented. The extension exposes exactly three
Pi tools:

- `web_search` — a bounded grounded answer when available, plus structured
  evidence with URLs, excerpts, dates, and provider provenance.
- `web_fetch` — bounded safe extraction from a selected URL.
- `web_research` — explicit, budgeted sequential search and fetches.

### Search routing

- Active OpenAI Responses models use the hosted Responses `web_search` tool;
  active Codex models use Codex's standalone `alpha/search` endpoint. With
  another active model, an authenticated OpenAI/Codex search model in Pi's
  registry can provide search without a model switch.
- Active Gemini models use Google Search grounding automatically.
- Active xAI Responses models use xAI web search automatically; select `xai-x`
  explicitly when the task requires X search.
- Active Anthropic Messages models use the server-side `web_search` tool
  automatically; active Meta Responses models use `web_search` grounding
  automatically.
- Other/local models use configured Exa automatically only when metered search
  is allowed; Exa returns semantic results with excerpts and reported usage.
  Configured DeepSeek is the cheaper second metered path (structured dates and
  excerpts through `site:`/`after:`/`before:` operators), selected after Exa
  under metered routing.
- In free-only mode, configured Brave is the conservative paced keyword/fresh
  path. Set `PI_SEARCH_PREFER_FREE=1` to prefer it before metered providers,
  with one metered fallback after a safe Brave failure.
  Parallel, Cloudflare Web Search, and the official X API remain explicit providers.
- Automatic routing permits at most one visible fallback after a safe
  authentication, rate-limit, or unavailable failure. Network, timeout, and
  post-dispatch HTTP failures remain final because their effects are uncertain.
  Explicit provider hints never fall through;
  there are no retry loops or provider fan-out.

All providers normalize into the same evidence-first result shape. Provider
answers are typed, cited, bounded, and marked untrusted rather than treated as
authoritative summaries. OpenAI/Codex search also exposes native context-size,
location, live-access, and content-type controls when requested.

## Configuration

The extension reads credentials only at construction or through Pi's model
registry; it never logs keys. Keys can live in a shell-local secret injector
(e.g. `fnox`) rather than global environment files — because providers are
registered only when their key is present at construction, an unset
variable simply leaves that provider disabled.

```bash
# Optional metered search for non-native/local models
export EXA_API_KEY=...
# Cheaper second metered path; selected after Exa when metered routing is allowed.
export DEEPSEEK_API_KEY=...            # $0.75 per 1K successful requests
# Allow metered providers (Exa, DeepSeek) in automatic routing:
# export PI_SEARCH_ALLOW_METERED=1
# Prefer admitted free-mode Brave before metered providers, with one metered
# fallback after a safe Brave failure:
# export PI_SEARCH_PREFER_FREE=1

# Optional last-resort keyword/fresh search
export BRAVE_API_KEY=...
# Configured Brave uses conservative free-mode admission by default:
# request starts are spaced by 1s and observed quota headers are honored.
# This explicit setting is optional; set it to 0 only when deliberately using
# metered Brave with the opt-in below.
export PI_SEARCH_BRAVE_FREE_ONLY=1
# Free mode does not inspect account billing or guarantee no paid overage.
# Explicit `provider: "exa"` or `"deepseek"` remains an intentional per-call opt-in.

# Explicit secondary providers
export PARALLEL_API_KEY=...
export X_API_BEARER_TOKEN=...         # explicit official X API search
# Optional: to deliberately disable Brave's default free-mode pacing:
# export PI_SEARCH_BRAVE_FREE_ONLY=0
# export PI_SEARCH_ALLOW_METERED=1

# Opt-in answer-synthesis providers (disabled by default; explicit provider
# hint only -- never selected automatically, never the native alias):
# export PI_SEARCH_ENABLE_PARALLEL_RESPONSES=1   # also needs PARALLEL_API_KEY
# export PI_SEARCH_ENABLE_BRAVE_ANSWERS=1       # also needs BRAVE_API_KEY on a plan with AI Answers
# Parallel Responses is metered per reasoning effort ($10-$250/1K requests);
# Brave Answers is $4/1K requests plus $5/1M tokens, billed separately
# from Brave search's free-mode admission.
```

Native-provider credentials come from Pi's model-registry authentication
context. Anthropic supports API keys, registry-owned bearer headers, and
workload identity federation; federation exchanges use the official SDK
protocol with bounded, cancellable requests. Anthropic Pro/Max subscription
search is not supported; its tokens are rejected before dispatch. Active Gemini/xAI models use native search automatically. For
search-only Gemini grounding, prefer Pi's current `gemini-flash-lite-latest`
model alias rather than full Flash/Pro or legacy model IDs. Explicit
`provider: "gemini"`, `"xai"`, `"xai-x"`, `"anthropic"`, or `"meta"` can use a
compatible registry model with `executionModel` even when another model is
active; this makes model and billing choice visible. Pi's `/login xai` subscription flow is supported by the
registry for Grok web/X search. A provider hint such as `provider: "exa"`,
`"deepseek"`, `"parallel"`, or `"x"` is strict and never falls through to
another provider.
Without a hint, the router selects available native search first, then Exa,
then DeepSeek, then Brave when the corresponding credentials and hard
constraints permit it.
Set `includeContent: true` on `web_search` only when bounded excerpts from
selected source pages are needed; this reuses the safe local fetch path. For
`web_research`, use `executionModel` with an explicit model-mediated `provider`
when a multi-query run should use a specific Gemini, xAI, Anthropic, Meta,
OpenAI, or Codex model.

### Cloudflare Web Search

Cloudflare routes search through Ceramic, Exa, or Linkup. It is an explicit
secondary provider, never an automatic choice or fallback:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export PI_SEARCH_CLOUDFLARE_PROVIDER=exa  # required: exa, linkup, or ceramic
# export PI_SEARCH_CLOUDFLARE_GATEWAY_ID=default
# export PI_SEARCH_CLOUDFLARE_BYOK_ALIAS=default
```

Use `provider: "cloudflare"` with `web_search` or `web_research`. The API token
needs **Workers AI Read** and **AI Gateway Read** permissions. Queries are
limited to 1,024 characters and results to 10. Domain/date/social filters and
native-model controls are rejected, not silently dropped. Results identify
both Cloudflare and the configured upstream.

An explicit BYOK alias fails if its stored key is missing. Without an alias,
Cloudflare uses the upstream's stored `default` key when present, otherwise
prepaid gateway credits. See [Cloudflare's API and billing instructions](https://developers.cloudflare.com/web-search/how-to-use/).

**Keep direct Exa as the default direct search choice for now.** It provides
richer controls than the gateway. Ceramic has an independent web index and
long result descriptions; it is not merely a keyword-only engine. Its much
lower advertised price does not establish comparable quality. More
importantly, [Ceramic's terms §7(n)–(p)](https://www.ceramic.ai/terms-of-service)
restrict result retention and extractability in ways that appear incompatible
with saved/exportable Pi transcripts unless contractually permitted. Clarify
those rights before using Ceramic. Zero Data Retention describes provider
handling, not permission to retain results yourself.

### DeepSeek Search

DeepSeek Search is a direct metered provider (`provider: "deepseek"`). The
adapter composes domain and inclusive publication-date filters into DeepSeek's
documented `site:`, `-site:`, `after:`, and `before:` query operators, and
requests the model-oriented summary rather than full page content; readable
pages remain `web_fetch`'s job. DeepSeek caps queries at 128 characters
including those operators, so a long filtered query is rejected before
dispatch instead of being truncated. Requests that need social, media,
location, context-size, token-budget, or live-access controls are rejected
rather than degraded. Date operators have day granularity, so the provider
window is widened to whole days and a warning is reported; time-of-day bounds
are then enforced locally on results that report a date. Results with a known
publication date are filtered to the requested inclusive range; undated
results remain visible with an explicit warning.

The adapter reads `DEEPSEEK_API_KEY` from the environment, like the other
direct providers. A DeepSeek login stored only in Pi's model registry does not
register it.

### Local and virtual models

Research queries retain the 2,000-character runtime limit. The tool schema
omits that nested string bound because llama.cpp cannot compile it; validation
still rejects overlong queries before search. This works with direct local
models and virtual routes without endpoint detection or request rewriting.

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

- Office, document, and text-based PDF URLs through pinned local
  `@firecrawl/anydoc` conversion to structured Markdown: DOC/DOCX, PPT/PPTX,
  XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV, and PDF. Conversion is local, runs
  outside the event loop, and requires no API key or hosted Firecrawl service.
  AnyDoc detects scanned/image-only and encrypted PDFs and fails explicitly;
  OCR is not implicit.
- An explicit `maxPages` request uses bounded local `pdftotext`, because
  AnyDoc does not expose page-range selection.
- YouTube captions through bounded local `yt-dlp` with no playlist, cookie, or
  media download behavior.

Use Bash, `git`, `gh`, `yt-dlp`, `ffmpeg`, or a browser workflow for local
files, repository operations, video downloads/frames, OCR, and JS-only pages.

### X posts, threads, and Articles

Pass an X/Twitter post or Article URL to `web_fetch`. Public reads use
[FxTwitter](https://docs.fxembed.com/api/introduction/) without keys, an X account,
or configuration. The post ID is sent to FxTwitter; no paid X API or Grok call is
made. This also applies to X URLs selected for search enrichment or research.
Results identify the extraction path and remain untrusted.

Long posts retain their full supplied text. Articles preserve headings, links,
lists, and embedded code. Threads use at most two public API calls and retain at
most 100 connected author posts. Missing/deleted posts and upstream omissions
mean **thread completeness is never guaranteed**, separately from output
truncation. Use `offset`/`nextOffset` for long output.

For authenticated access, run **`/search-x login`** once and sign in normally in
the dedicated Chrome, Chromium, or Brave window. A supported browser must already
be installed; no browser binary is downloaded. Confirm in Pi when signed in.
Subsequent automatic reads prefer this profile. Personal browser profiles and
cookies are never imported, and an authenticated failure does **not** send that
post ID to FxTwitter. Login may expire, and X may block automated browsers even
with an account; rerun login or explicitly choose public mode when appropriate.
Only loaded author posts are returned by the browser, not an exhaustive reply
crawl.

- `/search-x status` reports the mode and authorization state.
- `/search-x public` prefers FxTwitter without using the browser.
- `/search-x direct` persistently disables both extra paths, including for search
  enrichment and research. Tool arguments cannot override this user policy.
- `/search-x auto` restores browser-first, otherwise-public routing.
- `/search-x logout` disables browser access and removes its local profile. It
  preserves the selected mode and does not revoke an X session remotely.

The profile is stored privately under Pi's agent directory at
`pi-search/x/profile`. Manual login uses a normal browser network context.
Automated reads restrict HTTPS destinations to X and its asset hosts, pin their
DNS addresses, block WebSockets/service workers and media downloads, and enforce
an overall deadline and aggregate response-byte limit. No posting, liking, or
following controls are used. Browser access is serialized; another Pi session
using the same profile may report it busy.

`xMode: "auto" | "public" | "browser" | "direct"` selects a path for one fetch;
`browser` requires prior user authorization. FxTwitter returns Markdown even when
another format is requested; `outputFormat` reports the actual format.
`/handle/article/POSTID` links work through FxTwitter. Bare `/i/article/ARTICLEID`
links use the supplied page or the authorized browser; Article IDs are never
mistaken for publishing-post IDs. If X hides that page, supply its publishing
post URL instead.

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
