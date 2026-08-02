# pi-search brief

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The current branch and origin are clean at
`b7e0367`; the installed Git package was refreshed to runtime commit
`934ec0d`. The active Pi runtime contains only this web extension and exposes
exactly `web_search`, `web_fetch`, and `web_research`.

Shipped search adapters are OpenAI/Codex, Gemini, xAI web and semantic X,
Brave, Exa, Parallel, and explicit official X recent search. Fetching includes
pinned DNS/SSRF and redirect checks, streamed limits, local HTML/Markdown
extraction, bounded PDF text, and bounded YouTube captions. `web_research` is
an explicit single-provider, sequential, bounded orchestrator with optional
direct fetches and no hidden synthesis or fan-out.

## Long-term direction

The goal is a best-in-class provider portfolio by capability, not a provider
count or single-vendor dependency. Ordinary calls remain one-provider and
evidence-first; explicit provider selection and a future opt-in comparison
mode may use multiple providers. Hidden fallback, paid retries, and ambiguous
merged provenance remain out of contract.

Current portfolio:

- OpenAI/Codex: native general search and highest correctness priority.
- Gemini: Google-grounded alternative when explicitly metered.
- xAI web and `xai-x`: model-mediated web/social context.
- Brave: cost-controlled general direct search with default free-mode local pacing when a key is configured.
- Exa: explicit semantic retrieval and highlights; automatic preference is not assumed without measured quality evidence.
- Parallel: objective-oriented context retrieval.
- Official X API (`provider: "x"`): exact recent post/query/user retrieval
  with an explicit bearer credential and provider selection.

Direct local fetching remains the default for individual pages and PDFs. Pi,
Bash, `read`, `git`, `gh`, `yt-dlp`, `ffmpeg`, and vision workflows remain the
default owners for local repositories, media, OCR, and visual analysis.

## Verification

`bun run check` passes: 135 tests and 318 assertions, with TypeScript checking.
OpenAI/Codex failure metadata, blocked domain filters, stream cancellation,
fetch/PDF bounds, Brave free-mode pacing, provider metrics, official X
normalization, readable search rendering, and Exa partial-response handling
have deterministic coverage. The installed package was refreshed after the
readable-output fix. One live smoke call each passed for Brave, Exa, and
Parallel against `iana.org`; Brave returned account rate-limit windows, Exa
reported a $0.007 search cost, and Parallel returned normalized evidence.
Direct OpenAI, Gemini, xAI, and official X live rows remain unverified.

## Active work

`pi-search-az96` is the open benchmark task. Cost and result quality are the
primary criteria; latency is recorded but not optimized or repeatedly sampled.
The first four candidates are Brave, Exa, Parallel, and Gemini. Do not infer
free-tier eligibility from marketing pages or rank providers from one smoke
query. The cached Exa MCP package is not active in Pi's MCP configuration.

## Next action

The direct Exa path now preserves valid evidence from partial responses,
falls back from empty highlights to text/summary, ignores malformed optional
billing metadata, and exposes a $0.007 standard-call estimate for bounded
research budgets. `docs/provider-corpus.md` defines the minimum comparison
cases and human labels; no additional live requests were made. Next, run only
the minimum representative calls needed to choose between Brave, Exa, Parallel
modes, and Gemini grounding. Keep the current Brave default until that evidence
changes it. Restart any long-running Pi process after installing runtime
changes.
