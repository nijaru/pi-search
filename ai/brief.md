# pi-search brief

## Objective

Make `pi-search` a reliable, high-quality sole web extension for Pi. The
prior `pi-web-access` extension remains the operational reference, but this
package must improve on its task usefulness without importing unbounded
fan-out, opaque storage, or unsafe remote extraction.

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The branch is clean and synced at
`32c134f`; the installed package at
`/Users/nick/.pi/agent/git/github.com/nijaru/pi-search` is also at `32c134f`.
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
- automatic routing permits at most one visible fallback after an
  availability-like failure. Explicit provider hints, malformed/unsupported
  requests, and cancellation remain final.
- `web_search` can opt into bounded source enrichment through the existing
  local SSRF-safe fetcher with count, length, deadline, and cancellation
  limits.
- OpenAI/Codex, Gemini, and xAI native adapters preserve bounded grounded
  answer text, citations, execution model, and evidence metadata.

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
and one visible alternative for availability-like failures. There is no hidden
retry loop, paid fan-out, or fallback for explicit provider hints.
- Provider answers are optional and typed, cited, bounded, and marked
untrusted. Evidence remains the public source of truth; direct providers need
not synthesize answers.
- Source enrichment is explicit (`includeContent`) and uses the existing safe
fetch boundary. Browser/remote extraction, persistent cache/history, and
curator storage remain deferred until a concrete workflow requires them.
- Preserve fetch safety and deterministic offline coverage. Do not add
providers merely for count or rerun paid comparisons.

## Verification

`bun run check` passes: 148 tests and 356 assertions, with TypeScript clean.
Coverage now includes registry-driven cross-provider native selection, answer
normalization/citation alignment, bounded fallback behavior, optional source
enrichment through an injected fetcher, multibyte output bounds, bounded
fetch-attempt counts, cancellation mapping, and existing safety,
PDF, captions, cancellation, provider, and renderer fixtures. `git diff
--check` passes. A fresh Codex Pi process completed a live search with concise
cited output and no raw JSON. A fresh OpenRouter/DeepSeek process failed before
tool execution with `401 User not found`; this is an OpenRouter credential or
session blocker and does not validate the search path. No comparison calls were
made.

## Active tasks

- `pi-search-kd43`: rebaseline pi-search against pi-web-access search behavior;
  implementation pass is complete, but deliberate live/end-to-end validation
  and final acceptance remain open.

## Next sequence

1. Resolve the OpenRouter/DeepSeek credential or session issue if that
   workflow is still required, then exercise the installed package with the
   non-native model and confirm registry-native or Exa routing.
2. If dedicated credentials are intentionally available, run one explicit
   live smoke per remaining native/direct path and record skipped paths; do not
   benchmark latency or compare providers with paid calls.
3. Re-read failures from that exercise and fix only concrete correctness or UX
   defects. Then update the required-workflow/task docs and consider closing
   `pi-search-kd43`.
