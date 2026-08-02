# pi-search brief

## Objective

Re-establish whether `pi-search` can become a reliable, high-quality sole
web extension for Pi. The prior `pi-web-access` extension is the current
operational baseline; do not assume provider count or the current evidence-only
policy is sufficient. Preserve bounded fetch/PDF/caption extraction and
readable output while investigating concrete parity gaps first.

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The branch is clean and synced at
`82ee8bf`; renderer, output, Exa-routing, research-bound, provenance, and
expanded-metadata fixes are committed; the revised quality requirements and
rebaseline task are also saved. The user plans to return
to `pi-web-access` operationally for now; no package switch was performed.
The active Pi runtime currently exposes exactly
`web_search`, `web_fetch`, and `web_research`. The search description now
matches automatic Exa routing for non-native models.

Shipped adapters: OpenAI/Codex Responses, Gemini grounding, xAI web and X,
Brave, Exa, Parallel, and explicit official X recent search. Fetching includes
pinned DNS/SSRF and redirect checks, streamed limits, local HTML/Markdown
extraction, bounded PDF text, and bounded YouTube captions. Research is a
single-provider, sequential, budgeted workflow with optional direct fetches.

## Decisions in force

- Do not run provider-comparison calls. Use existing extension source,
  authoritative documentation, and the user's actual workflows to identify
  gaps; live calls are reserved for deliberate correctness smoke tests.
- Treat `pi-web-access` as the operational baseline until a parity plan is
  accepted. Its source confirms cross-provider OpenAI/Codex registry search,
  answer synthesis, broader routing, and curator/fetch workflows that
  `pi-search` does not currently match.
- The current `pi-search` native-first/Exa route is an implementation state,
  not a final product decision. Revisit cross-provider native search and
  optional answer synthesis before claiming replacement readiness.
- Keep safety, bounds, provenance, cancellation, and readable output as
  candidate advantages; prove they matter against actual workflows.

## Output status

All three tools now emit bounded readable model content instead of raw JSON
and provide compact default Pi renderers with expanded evidence/details.
Search shows three sources collapsed and complete metadata expanded; fetch
shows status/extraction and content; research shows stop status/counts and
expands source summaries. Deterministic renderer/output tests cover the new
behavior. A running Pi session can retain older code at startup, so start a
fresh session after reload.

## Verification

The latest full check passed: 141 tests, 336 assertions, TypeScript clean;
that check preceded documentation-only requirement updates.
Deterministic coverage includes OpenAI/Codex parsing and cancellation, provider
errors, domain constraints, fetch/PDF bounds, Brave pacing, Exa partial
responses, readable search/fetch/research output, compact renderers, and
provider metrics. One credentialed smoke each passed for Brave, Exa, and
Parallel; direct OpenAI, Gemini, xAI, and official X live rows remain
unverified. Do not repeat paid requests merely to measure latency.

## Active tasks

- `pi-search-kd43`: rebaseline pi-search against pi-web-access search behavior
  before further implementation.

## Next sequence

1. Use the prior extension for the user's current work if desired; do not
   switch packages automatically.
2. Inventory actual workflows and compare the old and current source behavior,
   especially OpenAI/Codex availability routing, answer/synthesis, multi-query
   search, fetch/content handling, and UI presentation.
3. Produce a minimal parity/advantage design before writing more code. Do not
   benchmark providers or add adapters merely because they exist.
