# pi-search

A standalone, provider-neutral web search and fetching extension for Pi.

## Install

```sh
pi install npm:@nijaru/pi-search
```

To upgrade an existing install, reinstall an explicit published version
(`pi install npm:@nijaru/pi-search@<version>`) and restart Pi. Pi leaves an
exact version pin in its extension settings unchanged during `pi update`.

Version `0.0.10` resolves direct-provider credentials on first use. Version
`0.0.9` runs configured credential commands during extension loading.

## Use

Two tools are available by default:

- `web_search` finds sources with URLs, dates, and labeled provider text.
- `web_fetch` reads a selected URL through bounded, safe extraction.

Pi's main model decides what to search, evaluates the evidence, and writes the
answer. The extension does not add a hidden research planner or another
answer-writing assistant.

```json
{"query":"Bun subprocess cancellation","domains":{"include":["bun.sh"]}}
```

Then read a selected source:

```json
{"url":"https://bun.sh/docs/runtime/child-process","maxLength":8000}
```

Search snippets are not verified page quotations. Results distinguish provider
excerpts, generated summaries, and text of unspecified origin. Fetched content
reports its extraction path. Everything retrieved remains untrusted data.
To also include a cited backend-generated answer, explicitly request
`advanced.answerMode: "auto"`; evidence alone is the default.

### Search routing

Automatic search prefers your active model's provider and authentication:

| Active chat | Preferred search |
| --- | --- |
| ChatGPT/Codex login | Codex standalone search |
| OpenAI API GPT | OpenAI Responses web search |
| Gemini | Google grounding |
| Grok | xAI web search, or X search for social constraints |
| Anthropic / Meta | The matching native adapter, when supported |
| Unsupported or local provider | Compatible approved alternatives |

Provider/API identity, not a model-name guess, determines the native path.
Automatic native search normally uses the active model; if the adapter excludes
it from automatic search, it selects an eligible model within the same provider
and authentication path. Switching chat providers changes the preference; an
unrelated cached Codex login does not take over.

Before dispatch, the extension skips backends that lack required capabilities,
authentication, or spending admission. After a known-safe rejection it advances
sequentially through an ordered list and stops at the first success. There is
no fan-out. Timeouts, network failures, malformed responses, cancellation, and
failures carrying reported usage do not trigger another provider.

The default alternatives are dedicated retrieval first: Exa, DeepSeek, Brave,
Parallel, Cloudflare; then Codex, OpenAI, Gemini, xAI, Anthropic, Meta. Social
requests also admit official X search and use xAI X rather than web search.
Only configured, compatible backends participate. Answer-synthesis adapters
never enter the default list.

Off-provider metered or unknown-cost alternatives require
`PI_SEARCH_ALLOW_METERED=1` or `PI_SEARCH_PREFER_FREE=1`. Without either,
only conservatively admitted Brave is an automatic off-provider alternative.
Prefer-free puts Brave first among alternatives, never ahead of the active
native path. Subscription quota and billing are unknown, not reported as free;
Brave's pacing is not a guarantee against account overage.

Usually leave `PI_SEARCH_PROVIDER` unset or `auto`. Optional preferences:

```bash
# Pin an installation primary instead of following chat:
# export PI_SEARCH_PROVIDER=gemini
# export PI_SEARCH_MODEL=<available-google-model-id>

# Replace the default alternatives with this ordered allowlist:
# export PI_SEARCH_FALLBACK_PROVIDERS=exa,deepseek,brave
# An empty value disables alternatives:
# export PI_SEARCH_FALLBACK_PROVIDERS=

# Register the explicit query-batch convenience tool:
# export PI_SEARCH_ENABLE_RESEARCH=1
```

Named primaries and allowlist entries deliberately admit their billing, but do
not enable disabled adapters or resolve credentials at startup. Missing
allowlist adapters are skipped, so one list can be used across installations.
A fixed primary must support the request; it does not silently change providers
to work around incompatible constraints. It can still use safe automatic
fallback after rejection. Per-call `advanced.provider` overrides (including
`native`) are strict and never fall through.

Most calls need no backend controls. Specialized requests use `advanced`:

```json
{"query":"recent runtime changes","advanced":{"provider":"exa"}}
```

`advanced` also holds `executionModel`, `mode`, `social`, `answerMode`, and
provider-native context, live-access, token-budget, and image controls.
`userLocation`, domain filters, and date filters stay at the top level.
Unsupported hard constraints are rejected, never silently dropped; an explicit
primary does not change providers to work around them. Automatic selection can
choose a compatible backend before any request is dispatched.

## Configuration

Direct-provider keys can come from environment variables or from shell
commands in the optional user-only file
`~/.pi/agent/pi-search/credentials.json` (under `getAgentDir()` when
`PI_CODING_AGENT_DIR` is set). For example, with Fnox installed:

```json
{
  "EXA_API_KEY": "!fnox --config \"$HOME/.config/fnox/config.toml\" --profile pi --no-defaults --if-missing error --non-interactive get EXA_API_KEY",
  "BRAVE_API_KEY": "!fnox --config \"$HOME/.config/fnox/config.toml\" --profile pi --no-defaults --if-missing error --non-interactive get BRAVE_API_KEY"
}
```

Any shell command that prints a key can be used; Fnox is not a dependency.
The file must be a flat object whose only supported names are `BRAVE_API_KEY`,
`EXA_API_KEY`, `DEEPSEEK_API_KEY`, `PARALLEL_API_KEY`, `X_API_BEARER_TOKEN`, and
`CLOUDFLARE_API_TOKEN`. Values must be nonempty `!<shell command>` references,
not plaintext keys. Do not embed secrets in the commands either.
`CLOUDFLARE_ACCOUNT_ID` and all billing/enable settings remain environment
variables; credentials alone do not enable spending or opt-in providers.

**Treat this file as executable code.** Keep it writable only by your user and
review its commands. No project credentials file is loaded. Commands run with
Pi's permissions and inherited environment, from the agent directory, using
`/bin/sh` on macOS/Linux or `cmd.exe` on Windows—not your interactive Fish
configuration. Use installed executables on Pi's `PATH` or absolute paths;
commands must not require terminal input.

**Credential lifecycle (`0.0.10`+):** Startup validates the file without
executing commands. Direct-provider hints use
nonempty env keys or validated command references to determine configuration;
answer-provider enable gates are unchanged.
Each command runs on its key's first use, at most once per extension instance;
concurrent calls and providers using the same key share its result. Unused keys,
fetch-only sessions, and `/search-x` commands do not run credential commands.
Each command has a 10-second timeout and a 16 KiB stdout limit. Trimmed stdout
becomes the private adapter credential; stderr is discarded. Keys are not written
to `process.env` or logged. Canceling a search stops its wait, not a shared command;
shutdown or `/reload` cancels and drains pending commands. Ordinary subprocess
cleanup uses a dedicated process group on macOS/Linux and `taskkill /t` on
Windows; commands must not launch detached daemons. Windows tree cleanup after
a shell has already exited is best-effort.

A configured command overrides the corresponding inherited variable. Invalid
JSON, unsupported names, or literal/nonstring values fail extension loading.
Command failure, empty stdout, timeout, or excessive output fails the affected
search with a sanitized error—never an env fallback. Failed command results are
also retained until reload. A missing file or omitted entry preserves env
support, including its existing whitespace handling. Configuration and inherited
environment are captured at load time. Restart Pi or run `/reload` to pick up
changes or refreshed keys; there is no per-request refresh. Native provider auth
still resolves through Pi's model registry at request time.

Alternatively, configure direct keys and routing settings in the environment:

```bash
# Optional direct search, independent of your chat model
export EXA_API_KEY=...
# Cheaper second metered path; selected after Exa when metered routing is allowed.
export DEEPSEEK_API_KEY=...            # $0.75 per 1K successful requests
# Admit metered/unknown-cost off-provider alternatives in automatic routing:
# export PI_SEARCH_ALLOW_METERED=1
# Prefer admitted free-mode Brave before other alternatives (after active native search).
# This also admits metered alternatives if Brave cannot serve the request:
# export PI_SEARCH_PREFER_FREE=1

# Optional last-resort keyword/fresh search
export BRAVE_API_KEY=...
# Configured Brave uses conservative free-mode admission by default:
# request starts are spaced by 1s and observed quota headers are honored.
# This explicit setting is optional; set it to 0 only when deliberately using
# metered Brave with the opt-in below.
export PI_SEARCH_BRAVE_FREE_ONLY=1
# Free mode does not inspect account billing or guarantee no paid overage.
# Explicit advanced.provider or PI_SEARCH_PROVIDER is a deliberate billing opt-in.

# Explicit secondary providers
export PARALLEL_API_KEY=...
export X_API_BEARER_TOKEN=...         # explicit official X API search
# Optional: to deliberately disable Brave's default free-mode pacing:
# export PI_SEARCH_BRAVE_FREE_ONLY=0
# export PI_SEARCH_ALLOW_METERED=1

# Opt-in answer-synthesis providers (disabled by default; explicit provider
# selection only -- never chosen by auto or the native alias):
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
search is not supported; its tokens are rejected before dispatch. Gemini,
xAI web/X, Anthropic, and Meta participate in active-provider routing and
approved native fallback. `PI_SEARCH_PROVIDER` or `advanced.provider` overrides
the normal preference. Optional `PI_SEARCH_MODEL` or `advanced.executionModel`
pins a compatible registry model; an explicit backend without a pin uses its
adapter's compatible registry selection. Pi's `/login xai` subscription flow is supported for Grok web/X search.
An explicit `advanced.provider: "native"` requires the active native path and
disables fallback for that call.

To fetch a few result pages within a search, pass
`fetch: { "maxResults": 2, "maxLength": 4000 }`. Omit it for ordinary search,
then use `web_fetch` after selecting a source.

### Cloudflare Web Search

Cloudflare routes search through Ceramic, Exa, or Linkup. Once configured, it
can serve as a dedicated metered fallback after Parallel. It can also be named
as a primary, allowlist entry, or per-call override:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export PI_SEARCH_CLOUDFLARE_PROVIDER=exa  # required: exa, linkup, or ceramic
# export PI_SEARCH_CLOUDFLARE_GATEWAY_ID=default
# export PI_SEARCH_CLOUDFLARE_BYOK_ALIAS=default
```

Use `advanced.provider: "cloudflare"` with `web_search` or the optional
`web_research`. The API token
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

DeepSeek Search is a direct metered provider (`advanced.provider: "deepseek"`). The
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

The adapter receives `DEEPSEEK_API_KEY` from the environment or the user
credentials command file, like the other direct providers. A DeepSeek login
stored only in Pi's model registry does not register it.

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
opt into bounded fetching of selected result pages with
`fetch: { "maxResults": 2, "maxLength": 4000 }`; fetched pages remain untrusted.
`web_fetch` owns direct HTTPS/HTTP fetching with SSRF protection, redirect
validation, response limits, cancellation, Markdown content negotiation, local
Readability/Turndown extraction, and untrusted-content fencing. It also supports:

- Office, document, and text-based PDF URLs through pinned local
  `@firecrawl/anydoc` conversion to structured Markdown: DOC/DOCX, PPT/PPTX,
  XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV, and PDF. Conversion is local, runs
  outside the event loop, and requires no API key or hosted Firecrawl service.
  Each conversion runs in a disposable subprocess with a 30-second deadline,
  bounded IPC, and a 2 MiB UTF-8 Markdown limit. Cancellation kills and joins the
  process. AnyDoc detects scanned/image-only and encrypted PDFs and fails
  explicitly; OCR is not implicit. Subprocess isolation contains native crashes,
  but is not a hard memory sandbox: AnyDoc materializes its result before the
  output check, so a hostile document can still pressure system memory.
- An explicit `maxPages` request uses bounded local `pdftotext`, because
  AnyDoc does not expose page-range selection.
- YouTube captions through bounded local `yt-dlp` with no playlist, cookie, or
  media download behavior.

Use Bash, `git`, `gh`, `yt-dlp`, `ffmpeg`, or a browser workflow for local
files, repository operations, video downloads/frames, OCR, and JS-only pages.

### Stable fetch paging

A fetch may return `snapshotId` and `nextOffset`. Continue that exact extraction
without another network request:

```json
{"url":"https://example.com/article","snapshotId":"<returned-id>","offset":8000,"maxLength":8000}
```

Repeat the original requested URL, not a redirected URL; equivalent URL
spellings (host casing, default port, fragment) identify the same extraction.
Omit extraction controls to inherit them. If you supply `format`, `readable`,
PDF/caption settings, or X options, they must match the retained extraction.
Only `offset` and `maxLength` change its paging. Missing, expired, evicted, or mismatched
snapshots fail explicitly; they never silently refetch. Omit `snapshotId` to
request a fresh live extraction.

Snapshots are memory-only and scoped to one Pi extension instance: at most
8 entries and 16 MiB of accounted payload, expiring 15 minutes after creation.
Reads do not extend expiry. Oversized extractions are not retained. Reload,
shutdown, or session replacement clears the store. Snapshot paging cannot
extend the fetcher's extraction/paging cap. Search enrichment and optional batch
fetches share the same store and report only IDs still retained when their
response is finalized. A large batch can return pages without IDs after eviction.
Unshown pages are released. X disconnect/direct-only changes stop future
browser reads, not access to content already retained in this local instance;
reload or shutdown clears that evidence along with all other snapshots.

### X posts, threads, and Articles

Pass an X/Twitter post or Article URL to `web_fetch`. Public reads use
[FxTwitter](https://docs.fxembed.com/api/introduction/) without keys, an X account,
or configuration. The post ID is sent to FxTwitter; no paid X API or Grok call is
made. This also applies to X URLs selected for search enrichment or research.
Results identify the extraction path and remain untrusted.

Long posts retain their full supplied text. Articles preserve headings, links,
lists, and embedded code. **Public post reads include conversation retrieval by
default**, with no browser setup, login, or approval prompt:

```json
{"url":"https://x.com/jack/status/20"}
```

The [FxTwitter conversation API](https://api.fxtwitter.com/2/openapi.json)
is paginated automatically, stopping after 8 pages, 200 replies, or a 20-second
conversation deadline. The existing aggregate response-byte limit still applies
(5 MiB by default). Local assembly is capped at 100 author-thread posts, 1,000
graph candidates, and 3 million characters. Repeated or malformed cursors stop
the crawl rather than looping. A later upstream failure or limit returns already
validated evidence with an explicit partial-result notice; caller cancellation
and SSRF failures still reject the request.

Posts are deduplicated, nested replies are connected across pages, and parents
appear before children. Source and parent-post links are retained. Upstream
pages are ranked by likes; reply branches whose parent chains cannot be verified
are omitted with a warning. An invalid selected post or contradictory first-page
author chain still fails rather than guessing which source data is correct.
`xConversation` metadata reports pages read, author/reply counts, the stop reason,
and whether upstream pagination ended. **Exhausted pagination
does not prove that every X reply was returned**: hidden, deleted, protected,
nested, or upstream-omitted replies may still be missing.

To request fewer replies, use `xMode: "public"` with `xReplies` from 0–200.
Zero selects an author-thread-only read (at most two public API calls). Explicit
reply limits require a publishing post URL, not a bare `/i/article/ARTICLEID`
link; bare Article links can supply the Article body but not its conversation.
Public reads never use the browser. Persistent direct-only policy is still
respected, and a previously authorized browser retains its existing priority in
`auto` mode; browser/direct DOM reads include only the selected post.

Conversation coverage is separate from output truncation. Use `offset`/
`nextOffset` for long extracted output, not to bypass conversation crawl limits.
Use the returned `snapshotId` with the original requested URL for stable paging;
omitted extraction controls inherit the retained values. An offset without a snapshot ID refetches
live content, so changing posts or reply rankings can change later pages.
Offsets and character limits use UTF-16 units; use `maxLength` of at least 2 for
emoji and other astral characters.
No media download or paid API is used.

For authenticated access, use your **existing signed-in browser**:

1. Enable remote debugging in `brave://inspect/#remote-debugging` (Chrome:
   `chrome://inspect/#remote-debugging`). This permits local browser control;
   pi-search never enables it for you or restarts your browser.
2. Run **`/search-x connect`** for Brave, or `/search-x connect chrome` or
   `/search-x connect chromium`.
3. Confirm in Pi and approve the browser's native connection prompt.

Automatic X reads now prefer your existing login. No separate profile or browser
installation is needed, and cookies are never copied. Each new connection may
require browser approval; the connection is reused during the Pi session.
An authenticated failure does **not** send the target to FxTwitter. Sign in to
X normally if your login expires, or explicitly choose public mode. Browser and direct HTML reads return only the selected post or Article:
adjacent posts by the same author do not prove a thread relationship. They do
not fetch comments or crawl threads. If multiple profiles
have X tabs open, close the other profiles' X tabs before reading.

- `/search-x status` reports the mode and authorization state.
- `/search-x public` prefers FxTwitter without using the browser.
- `/search-x direct` persistently disables both extra paths, including for search
  enrichment and research. Tool arguments cannot override this user policy.
- `/search-x auto` restores browser-first, otherwise-public routing.
- `/search-x disconnect` revokes extension access while preserving the selected
  mode. Your browser, X login, and remote-debugging setting remain unchanged.

Only the mode and authorized browser name are stored under Pi's agent directory
at `pi-search/x/preferences.json`. The reader attaches only to its own temporary
background tab; existing tabs are not navigated or instrumented. Cancellation
closes the owned tab; shutdown also disconnects without closing your browser.
If the connection drops before tab creation is acknowledged, a blank temporary
tab may remain.

In that temporary tab, requests are limited to HTTPS X/asset hosts and read
operations. Redirects are checked before following, private DNS answers are
rejected, and service workers are bypassed for that tab. A restrictive page
policy blocks frames, workers, and media; WebSockets and popup controls are
blocked. Extraction has an overall deadline, bounded output, and an observed
response-byte limit (20 MiB by default, including the X application's scripts).
This is **not** the direct fetcher's DNS-pinned transport or a browser-wide
network sandbox: it uses your browser's network configuration,
and in-flight traffic can exceed the observed limit before the tab closes.
No posting, liking, or following controls are used.

`xMode: "auto" | "public" | "browser" | "direct"` selects a path for one fetch;
`browser` requires prior user authorization. FxTwitter returns Markdown even when
another format is requested; `outputFormat` reports the actual format.
`/handle/article/POSTID` links work through FxTwitter. Bare `/i/article/ARTICLEID`
links use the supplied page or the authorized browser; Article IDs are never
mistaken for publishing-post IDs. If X hides that page, supply its publishing
post URL instead.

## Optional search-and-fetch batches

Set `PI_SEARCH_ENABLE_RESEARCH=1` and reload Pi to register `web_research`.
It executes caller-supplied queries sequentially and optionally fetches result
URLs. It does not generate queries, judge sources, or synthesize an answer.
For adaptive research, let Pi alternate `web_search` and `web_fetch`.

```json
{
  "question":"How do Bun and Node cancel subprocesses?",
  "queries":["Bun subprocess cancellation","Node child_process AbortSignal"],
  "fetchResults":2,
  "budget":{
    "maxSteps":4,
    "maxProviderCalls":2,
    "maxFetches":2,
    "timeoutMs":60000,
    "maxOutputChars":20000
  }
}
```

Each query gets its own capability/preflight plan and uses the same ordered
safe fallback as search. After a successful fallback, actually rejected
predecessors are retired for the rest of the batch. A backend skipped only for
one query's limits remains eligible for later queries.
There is no fan-out. Domain/date filters apply to every query and candidate.
`maxProviderCalls` and `maxSteps` count every extension search attempt, including
fallback, not searches a hosted backend may perform internally. Optional
`maxEstimatedCostUsd` stops new work based on per-request estimates; it is not
a guaranteed billing cap and is rejected for backends without an estimate.
`estimatedCostUsd` includes unconfirmed reservations; `usage.costUsd` contains
only provider-reported cost. Proven-unbilled rejections release their planning
reservations; ambiguous failures retain them. A threshold never dispatches an
unknown-estimate candidate. Without a threshold, partial estimates explicitly
disclose unknown-cost calls through `unknownCostProviders` and the spending
headline, even when ordinary warnings are shortened.

### Tool-call migration

The redesigned interface replaces flat search controls with `advanced`:
`provider`, `executionModel`, `mode`, `social`, `answerMode`, and native controls
move there. `includeContent`/`contentResults`/`contentMaxLength` become
`fetch: { "maxResults": 2, "maxLength": 4000 }`. Batch provider/model overrides
also move to `advanced`, and its budget uses `maxEstimatedCostUsd` instead of
`maxCostUsd`. Rerun old tool calls using the current schema; no legacy argument
translation is added. Research and provider answers are opt-in. Automatic
routing now follows the active provider/authentication, with approved ordered
alternatives; `PI_SEARCH_FALLBACK_PROVIDERS` replaces the singular
`PI_SEARCH_FALLBACK_PROVIDER` setting.

## Development

```bash
bun install
bun run check
```

Credential-gated live provider checks are separate; see
[`docs/live-smoke.md`](docs/live-smoke.md). They never run from `bun test`.

Architecture, provider billing policy, and remaining validation priorities are
in [`docs/DESIGN.md`](docs/DESIGN.md),
[`docs/provider-policy.md`](docs/provider-policy.md), and
[`docs/implementation-plan.md`](docs/implementation-plan.md).

`pi-search` is the sole active web extension. Do not install a second web
extension with overlapping tools; the deferred specialty workflows are
intentionally outside this package until a concrete requirement justifies
owning them.

## License

MIT
