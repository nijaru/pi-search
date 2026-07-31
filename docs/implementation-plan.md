# pi-search implementation plan

This is the tracked source of truth for implementation order. `handoff.md` is
local session context and may summarize this file, but it is intentionally
ignored by git.

## 0. Contracts and design gate — complete

- Public boundary is `web_search`, `web_fetch`, and `web_research`.
- Model/auth execution context is explicit.
- Provider profiles, usage metadata, hard-option reporting, and research
  budgets are defined and tested.
- Direct fetching is local; remote extraction is not implicit.

## 1. Cost-controlled `web_search` — complete

The shipped search path is native OpenAI/Codex plus optional Brave. Native
search is selected strictly for an active OpenAI/Codex model. Brave requires an
explicit free-capacity assertion or metered opt-in. There is no Exa, Parallel,
Gemini, xAI, retry, or hidden provider fallback.

Acceptance evidence:

- Query and result limits, cancellation, and bounded timeout.
- Model-registry authentication for native search.
- Brave API-key construction without logging credentials.
- Structured evidence normalization and provenance.
- Domain constraints and unsupported behavior are explicit.
- Stable auth, HTTP, rate-limit, malformed, timeout, and cancellation errors.
- Offline fixtures for both shipped providers.

## 2. Direct `web_fetch` — complete

Direct HTTP fetching uses pinned DNS, SSRF and redirect checks, streamed byte
limits, local Readability/Turndown extraction, one deadline, cancellation, and
untrusted-content fencing. PDF URLs use bounded local `pdftotext`; YouTube URLs
use bounded local captions-only `yt-dlp`. Both specialty paths clean up
processes and temporary files and never call a remote extraction service.

Successful results report format, extraction method, redirect count, bytes read,
truncation, and `contentTrust: "untrusted"`.

## 3. Capability-aware routing — complete

The router selects exactly one provider. Native OpenAI/Codex wins for its active
model. Brave is eligible only when configured and explicitly allowed. Known
quota and transient failures remain visible; paid fallback is forbidden.

## 4. Budgeted `web_research` — complete

`web_research` accepts caller-supplied queries, selects one provider once, runs
sequentially, counts searches/fetches/steps, enforces one overall deadline,
bounds output, and reports partial completion. It performs no hidden query
planning, synthesis, provider fan-out, or retry. A cost ceiling is rejected
when the selected provider lacks a reliable per-call estimate.

## Deferred / outside ownership

- Public `web_find` or `web_browse` tools.
- Browser automation, crawling, remote extraction, and provider fan-out.
- Video downloads, frames, visual analysis, OCR, and implicit GitHub cloning.
  Use Bash, `yt-dlp`, `ffmpeg`, `git`, or `gh` explicitly.
- Exa, Gemini, Parallel, and xAI adapters unless a concrete workflow justifies
  their cost.
- Benchmarking inside this runtime package; use a separate evaluation project.
