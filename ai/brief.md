# pi-search brief

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The current branch and origin are clean at
`f921c38`; the installed Git package was refreshed to that commit. The active
Pi runtime contains only this web extension and exposes exactly `web_search`,
`web_fetch`, and `web_research`.

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
- Brave: controlled general direct search with default free-mode local pacing when a key is configured.
- Exa: semantic retrieval and highlights.
- Parallel: objective-oriented context retrieval.
- Official X API (`provider: "x"`): exact recent post/query/user retrieval
  with an explicit bearer credential and provider selection.

Direct local fetching remains the default for individual pages and PDFs. Pi,
Bash, `read`, `git`, `gh`, `yt-dlp`, `ffmpeg`, and vision workflows remain the
default owners for local repositories, media, OCR, and visual analysis.

## Verification

`bun run check` passes: 131 tests and 303 assertions, with TypeScript checking.
OpenAI/Codex failure metadata, blocked domain filters, stream cancellation,
fetch/PDF bounds, Brave free-mode pacing, provider metrics, and official X
normalization have deterministic coverage. Installed package refresh passed.
A fresh Pi Codex call previously returned structured evidence.

Credentialed live rows for direct OpenAI, Gemini, xAI, Brave, Exa, Parallel, and
the official X API remain skipped unless dedicated smoke credentials are
provided. Do not claim those providers passed live tests. The X and other live
smoke dry-run paths are present and fail closed.

## Completed planning gates

The provider-role evaluation harness, X API comparison, selective-provider
evaluation, and dynamic-page ownership evaluation are complete. Perplexity is
still conditional on a measured hard date/path/domain gap; SearXNG is
self-hosted-only; browser/remote extraction remains conditional on failed-page
evidence. No open tasks remain in `tk`.

## Next action

The default Brave path was restored after a runtime smoke exposed that a
configured key was rejected unless an optional flag was set. It now paces
free-mode request starts by one second by default; `=0` requires deliberate
metered opt-in. Active Gemini/xAI models and explicitly selected direct
providers likewise no longer require a redundant global metered flag. Refresh
or restart any long-running Pi process after installing this change. Only
measured future gaps should reopen deferred work.
