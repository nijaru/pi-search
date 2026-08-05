# pi-search brief

## Objective

Make `pi-search` a reliable, high-quality sole web extension for Pi. The
prior `pi-web-access` extension remains the operational reference, but this
package must improve on its task usefulness without importing unbounded
fan-out, opaque storage, or unsafe remote extraction.

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. Repository HEAD includes the pushed
YouTube acceptance fix and dependency cleanup; the installed checkout was
refreshed to `1a137a1`. The active runtime exposes exactly `web_search`,
`web_fetch`, and `web_research`; `pi-web-access` is not installed as an
overlapping runtime. Pi must be reloaded after a runtime refresh to execute
new search behavior.

The search-plane design and first implementation pass are complete:

- `web_search` returns a bounded typed provider answer with citations when a
  native backend supplies one, otherwise readable evidence; answer text and
  fetched pages are explicitly untrusted.
- automatic routing uses active native OpenAI/Codex/Gemini/xAI first, then an
  authenticated OpenAI/Codex Responses model available in Pi's registry even
  when another model is active, then configured Exa, then paced Brave;
  Parallel and exact X remain explicit.
- automatic routing permits at most one visible fallback after a safe
  authentication, rate-limit, or unavailable failure. Network, timeout, and
  post-dispatch HTTP failures remain final because their billing effect is
  uncertain. Explicit provider hints and malformed/unsupported requests remain
  final.
- `web_search` can opt into bounded source enrichment through the existing
  local SSRF-safe fetcher with count, length, deadline, and cancellation
  limits.
- OpenAI/Codex, Gemini, and xAI native adapters preserve bounded grounded
  answer text, support/annotation-aligned citations, selected execution model,
  usage metadata, and evidence. Explicit Gemini/xAI/OpenAI model selection is
  available through `provider` + `executionModel`; `web_research` propagates it
  across its bounded query sequence.
- Exa maps published-date ranges; xAI X and official X map bounded handles and
  dates; unsupported hard constraints are rejected at both router and adapter
  boundaries.

Fetching remains direct/local with pinned DNS/SSRF and redirect validation,
streamed limits, cancellation, Readability/Markdown extraction, bounded PDF
text, and bounded YouTube captions. The YouTube path uses local `yt-dlp` with
configuration ignored, no media download, bounded caption files, and
cue-aware VTT cleanup. Research remains explicit, sequential, and budgeted; it
uses one selected provider and does not use search fallbacks.

## Decisions in force

- Do not run provider-comparison calls. Use existing extension source,
authoritative documentation, and the user's workflows for portfolio decisions;
live calls are only deliberate correctness smoke tests.
- Built-in OpenAI/Codex search is preferred when Pi has an authenticated
Responses model, including cross-provider registry selection. This is an
intentional use of credentials already configured in Pi and is reported in
response metadata.
- Normal automatic search makes at most two provider calls total: one primary
and one visible alternative for safe authentication, rate-limit, or unavailable
failures. Network, timeout, and post-dispatch HTTP failures have uncertain
billing effects and remain final. There is no hidden retry loop, paid fan-out,
or fallback for explicit provider hints.
- Provider answers are optional and typed, cited, bounded, and marked
untrusted. Evidence remains the public source of truth; direct providers need
not synthesize answers. Model-mediated adapters reject completed envelopes with
no inspectable evidence.
- Source enrichment is explicit (`includeContent`) and uses the existing safe
fetch boundary. Browser/remote extraction, persistent cache/history, and
curator storage remain deferred until a concrete workflow requires them.
- Preserve fetch safety and deterministic offline coverage. Do not add
providers merely for count or rerun paid comparisons.

## Verification

`bun run check` passes: 169 tests and 404 assertions, with TypeScript 7.0.2
clean after aligning the Pi development dependencies to 0.83.0, TypeBox to
1.3.10, and adding direct `pi-ai` 0.83.0 development coverage. `bun outdated`
reports no remaining package updates and `git diff --check` passes. Bun and
pnpm installs now replace deprecated `node-domexception` with the maintained
native-DOMException drop-in `@profoundlogic/node-domexception@1.0.2` and pin
non-deprecated `@aws-sdk/core@3.976.0`; the actual `pi update --extensions` run
completed without either warning. A live caption-only extraction using
installed `yt-dlp` 2026.07.04 succeeded for a public video without media
download; the old unsupported `--no-netrc` flag was removed and VTT
header/numeric-caption handling was corrected. Coverage now
includes registry-driven cross-provider native selection, answer
normalization/citation alignment, bounded fallback behavior, optional source
enrichment through an injected fetcher, multibyte output bounds, bounded
fetch-attempt counts, cancellation mapping, and existing safety, PDF, captions,
cancellation, provider, and renderer fixtures. A fresh installed Pi process
completed live smokes for active OpenAI/Codex,
explicit Exa, xAI web search, xAI X search, and bounded Readability fetch; all
returned clean bounded output except the constrained xAI X request, which
completed without parseable citations and was correctly rejected by the
evidence-first boundary. Exa reported $0.007 for its smoke. The xAI web and
X smokes reported 47,360 and 26,693 total tokens; these were single correctness
calls, not a comparison, but xAI search is materially metered and should not
be retried or made an unbudgeted fallback. The current search recommendation
is the Pi-available `gemini-flash-lite-latest` model alias; full Flash/Pro and
legacy Gemini model IDs are not used for search smoke or examples. A test with
`gemini-3.6-flash` and `gemini-flash-lite-latest` initially returned HTTP 401
through the extension even though the fnox key worked directly. The root cause
was a real adapter bug: generic model auth added `Authorization: Bearer` beside
Google's `x-goog-api-key`; Google rejects that combination with
`API_KEY_SERVICE_BLOCKED`. Fixed in `18775fc` by disabling the generic bearer
header for Gemini. After reload, Lite grounding returned sources, but the
arbitrary 512-token cap caused `MAX_TOKENS`; the cap was first raised and then
removed to match Google's optional generation config and the mature reference
adapter. Grounding redirect URLs now receive one bounded canonical-URL lookup,
with the original preserved as `sourceUrl` if lookup fails; deterministic
success/failure fixtures cover this. The final post-change live Lite smoke
passed after restart: three canonical Google documentation sources, one
provider search query, no warnings, and no `MAX_TOKENS`. OpenRouter/DeepSeek
still has the separate earlier `401 User not found` credential/session
blocker. No provider comparison calls were made.

## Active tasks

- No blocking implementation task remains. The constrained xAI X no-citation
  result is a conditional investigation item, not a reason to spend another
  metered request without a reproduced workflow.
- `pi-search-3jx8`: investigate browser/Chrome MCP as a separate extension,
  not part of pi-search's default fetch path.

## Next sequence

1. Keep the current three-tool runtime stable; restart Pi after the latest
   extension refresh to load the dependency cleanup and YouTube fix.
2. Investigate a separate browser/Chrome MCP option when that workflow matters.
3. Inspect a raw xAI response only if an actual X workflow reproduces the
   no-citation result; do not run provider comparisons.
