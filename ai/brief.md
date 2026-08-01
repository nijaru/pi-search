# pi-search brief

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. It exposes exactly `web_search`,
`web_fetch`, and `web_research`. The active Pi runtime contains only this web
extension; `pi-web-access` is a source reference, not a runtime dependency.

Shipped search adapters are OpenAI/Codex, Gemini, xAI web and X, Brave, Exa,
and Parallel. Fetching includes pinned DNS/SSRF and redirect checks, streamed
limits, local HTML/Markdown extraction, bounded PDF text, and bounded YouTube
captions. `web_research` is an explicit single-provider, sequential, bounded
orchestrator with optional direct fetches and no hidden synthesis or fan-out.

## Long-term direction

The goal is a best-in-class provider portfolio by capability, not a provider
count or single-vendor dependency. Ordinary calls remain one-provider and
evidence-first; explicit provider selection and a future opt-in comparison
mode may use multiple providers. Hidden fallback, paid retries, and ambiguous
merged provenance remain out of contract.

The tracked priorities are:

1. OpenAI/Codex production correctness and live verification.
2. Efficient direct page and PDF fetching with strong safety and extraction
   fidelity.
3. Brave free-mode admission control and truthful quota/billing behavior.
4. A provider-role quality/cost evaluation harness before adding overlap.
5. Explicit capability options and an xAI X versus official X API decision.
6. Selective Perplexity/SearXNG/Tavily/Anthropic or browser additions only when
   measured workflows justify them.

Pi/Bash/`read`/`git`/`gh`/`yt-dlp`/`ffmpeg`/vision workflows remain the default
owners for local repositories, media, OCR, and visual analysis.

## Active tasks

Open tasks are tracked with `tk`; current P1 work covers OpenAI/Codex, direct
fetch/PDF quality, and Brave admission. P2 work covers provider evaluation,
capability contracts, and dedicated X comparison. P3 work covers selective
provider additions and dynamic-page ownership.

## Verification and blockers

Offline checks and the fresh Pi Codex smoke passed previously. Dedicated live
smoke calls for Gemini, xAI, Brave, Exa, and Parallel remain unverified because
provider-specific smoke credentials were not configured. Do not claim those
providers passed. Current planning edits are uncommitted until reviewed.

## Next action

Start `pi-search-701w` (OpenAI/Codex production gate) and `pi-search-cu5b`
(fetch/PDF quality) in priority order, then implement `pi-search-bg04`
(Brave free-mode admission). Keep the provider evaluation task blocked until
those production gates are verified.
