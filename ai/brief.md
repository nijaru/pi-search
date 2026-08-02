# pi-search brief

## Objective

Make `pi-search` a reliable, high-quality sole web extension for Pi within its
current scope: native provider search, Exa-backed non-native search, bounded
fetch/PDF/caption extraction, and explicit bounded research. Normal tool output
must be readable and compact; structured details remain available without raw
JSON in normal chat presentation.

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The branch is clean and synced at the
last context commit; renderer, output, and routing changes below are in the
working tree and need a commit/push before installation. The installed Git
package predates these latest changes.
The active Pi runtime contains only this web extension and exposes exactly
`web_search`, `web_fetch`, and `web_research`.

Shipped adapters: OpenAI/Codex Responses, Gemini grounding, xAI web and X,
Brave, Exa, Parallel, and explicit official X recent search. Fetching includes
pinned DNS/SSRF and redirect checks, streamed limits, local HTML/Markdown
extraction, bounded PDF text, and bounded YouTube captions. Research is a
single-provider, sequential, budgeted workflow with optional direct fetches.

## Decisions in force

- Provider order: active-model native search first; Exa for non-native models
  when `EXA_API_KEY` is configured; other direct providers only when their
  policy is explicit and justified. A provider failure never triggers a second
  network call, retry, or hidden fan-out.
- OpenRouter/DeepSeek cannot transparently use OpenAI or Gemini native search;
  doing so would be a separate provider/model call with its own billing.
- Exa is the preferred non-native path because it returns semantic results,
  highlights, domain filtering, request IDs, and reported cost. Its direct
  adapter has deterministic fixtures and a successful credentialed smoke.
- Gemini grounding is native-only; its current paid docs list 5,000 free
  search requests shared across Gemini 3.x, then $14/1,000 search queries,
  with model input/output tokens billed separately. One request can issue
  multiple search queries.
- Brave is a last-resort keyword/fresh provider, not the semantic default.
  Parallel remains a secondary direct provider pending quality evidence.
- All tools need compact readable model-visible content and compact default Pi
  TUI renderers with expanded details on demand. Raw JSON is not acceptable in
  normal chat output.

## Output status

All three tools now emit bounded readable model content instead of raw JSON
and provide compact default Pi renderers with expanded evidence/details.
Search shows three sources collapsed; fetch shows status/extraction and
content; research shows stop status/counts and expands source summaries.
Deterministic renderer/output tests cover the new behavior. A running Pi
session can retain older code at startup, so install the new commit and start
a fresh session.

## Verification

The latest full check passed: 139 tests, 333 assertions, TypeScript clean.
Deterministic coverage includes OpenAI/Codex parsing and cancellation, provider
errors, domain constraints, fetch/PDF bounds, Brave pacing, Exa partial
responses, readable search/fetch/research output, compact renderers, and
provider metrics. One credentialed smoke each passed for Brave, Exa, and
Parallel; direct OpenAI, Gemini, xAI, and official X live rows remain
unverified. Do not repeat paid requests merely to measure latency.

## Active tasks

- `pi-search-az96`: benchmark provider quality and all-in cost.
- `pi-search-a9di`: make native OpenAI and Codex search production-correct.
- `pi-search-kkxo`: implement compact Pi rendering for all web tools.
- `pi-search-ee3u`: make Exa the non-native search path.
- `pi-search-i6v0`: finish provider-neutral fetch and research quality audit.

## Next sequence

1. Commit/push the renderer, output, Exa-routing, tests, and docs changes.
2. Refresh the installed Git package and start a fresh Pi session; verify one
   OpenRouter/DeepSeek call routes to Exa and displays compact output.
3. Run only one deliberate native smoke per OpenAI/Codex path if credentials
   become available; current offline audit is strong.
4. Audit fetch/research scope and run the minimum provider comparison corpus.
