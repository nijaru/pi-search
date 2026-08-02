# pi-search brief

## Objective

Make `pi-search` a reliable, high-quality sole web extension for Pi. The
prior `pi-web-access` extension remains the operational reference, but this
package must improve on its task usefulness without importing unbounded
fan-out, opaque storage, or unsafe remote extraction.

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The branch is clean and synced at `9a18341`; the installed package at
`/Users/nick/.pi/agent/git/github.com/nijaru/pi-search` remains at `61e71f9`
until the package is refreshed after this commit.
The active runtime exposes exactly `web_search`, `web_fetch`, and
`web_research`. `pi-web-access` is not installed as an overlapping runtime.

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
text, and bounded YouTube captions. Research remains explicit, sequential, and
budgeted; it uses one selected provider and does not use search fallbacks.

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

`bun run check` passes: 165 tests and 395 assertions, with TypeScript clean.
Coverage now includes registry-driven cross-provider native selection, answer
normalization/citation alignment, bounded fallback behavior, optional source
enrichment through an injected fetcher, multibyte output bounds, bounded
fetch-attempt counts, cancellation mapping, and existing safety,
PDF, captions, cancellation, provider, and renderer fixtures. `git diff
--check` passes. A fresh Codex Pi process completed a live search with concise
cited output and no raw JSON. A fresh OpenRouter/DeepSeek process failed before
tool execution with `401 User not found`; this is an OpenRouter credential or
session blocker and does not validate the search path. One direct Exa smoke
passed with bounded IANA evidence, no warnings, a request ID, and
provider-reported cost of $0.007; a fresh installed Pi smoke then returned
three concise Exa source links with no raw JSON. No comparison calls were made.

## Active tasks

- `pi-search-kd43`: rebaseline pi-search against pi-web-access search behavior;
  model-mediated routing/constraint pass is complete offline. Exa direct and
  installed tool-path smokes passed, but Gemini/xAI/official-X live acceptance
  and non-native OpenRouter/DeepSeek acceptance remain open; the latter is
  blocked by its credential/session failure.

## Next sequence

1. Refresh the installed package after the implementation commit and run the
   deliberate provider smoke gates only when credentials are intentionally
   available: OpenAI/Codex first, then Gemini/xAI/X. Do not benchmark latency
   or compare providers with paid calls.
2. Repair the OpenRouter/DeepSeek credential or session issue if that workflow
   is still required, then run one installed non-native smoke and confirm
   automatic Exa routing. Automatic routing skips incompatible OpenAI
   chat-completions models instead of failing before the normal registry/direct
   path.
3. Re-read any concrete failure, update the required-workflow/task docs, and
   close `pi-search-kd43` only after the remaining live gates pass.
