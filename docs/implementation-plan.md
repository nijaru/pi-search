# Remaining implementation priorities

The shipped architecture is maintained in [DESIGN](DESIGN.md), usage in
[README](../README.md), and provider decisions in
[provider-policy](provider-policy.md). Completed implementation history is in
git rather than a second description of current behavior.

## Credential-gated validation

These checks consume quotas or money and never belong to the default offline
suite. Use [live-smoke](live-smoke.md), one deliberately selected backend at a
time. A skipped credentialed check is not evidence that an external contract
works.

- Audit OpenAI Responses and Codex standalone search against current upstream
  contracts: model/auth selection, resolved endpoint routing, citations, hard
  constraints, incomplete streams, cancellation, usage, and rate-limit errors.
- Exercise representative HTML, Markdown, text, JSON, redirects, oversized
  responses, PDFs, and scanned/encrypted failures. Check extraction fidelity
  and stable snapshot paging without adding a browser or remote converter.
- Verify configured direct search, explicit fallback diagnostics, source
  enrichment, and strict per-call selection. Do not run comparison calls merely
  to rank providers; use representative published evidence for portfolio
  decisions.
- Preserve provider-reported Brave quota windows and the distinction between
  local admission/pacing and account billing. A 1 RPS limiter proves neither
  free capacity nor absence of overage.
- Validate hard date/domain/social/media constraints only on documented
  compatible adapters. Do not substitute broad web results for exact X search.
- Check a clean Pi install can resolve pinned local document-conversion native
  dependencies on supported platforms; offline source tests alone do not
  establish installation compatibility.

## Selective additions

These are hypotheses, not commitments or a checklist to fill out:

- Expand official X API lookup/timelines/archive only for an actual exact-access
  requirement; xAI X remains the semantic model-mediated path.
- Add Perplexity only if hard date/path/domain filters materially improve a
  required workflow beyond shipped backends.
- Consider SearXNG only for explicit self-hosting/privacy needs.
- Consider Tavily or remote extraction only for a demonstrated quality or
  ownership gap that justifies their auth, cost, retention, and privacy burden.
- Integrate hosted search into the main Pi request only when Pi owns its full
  event/citation/persistence/replay/cancellation/usage lifecycle. Injecting a
  request field alone is not that integration.

## Outside current ownership

- General authenticated browsing, JS rendering, crawling, remote extraction,
  and provider fan-out. Selected X posts/Articles remain the reviewed exception
  documented in README.
- Video downloads/frames, visual analysis, and OCR: use explicit Bash,
  `yt-dlp`, `ffmpeg`, or a dedicated vision workflow.
- Local filesystem/repository work and implicit GitHub cloning: use `read`,
  Bash, `git`, and `gh`.
- Persistent search history, persistent document caches, hidden answer-writing
  agents, and telemetry. The bounded memory-only snapshot store is for stable
  paging, not an index or an archive.
