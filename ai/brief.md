# pi-search brief

## Objective

Make `pi-search` a reliable, high-quality sole web extension for Pi. The
prior `pi-web-access` extension remains the operational reference, but this
package must improve task usefulness without importing unbounded fan-out,
opaque storage, or unsafe remote extraction.

## Current state

`pi-search` is the public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. Repository HEAD is `059dcb4`, pushed to
`origin/main`; the active runtime exposes exactly `web_search`, `web_fetch`,
and `web_research`, and `pi-web-access` is not installed as an overlapping
runtime. A running Pi process must be restarted after an extension refresh.
The repository is clean after the context save.

The search plane is implemented and bounded:

- Native OpenAI/Codex, Gemini, and xAI web/X adapters preserve cited answers,
  inspectable evidence, request/model/usage metadata, and untrusted-content
  boundaries.
- Automatic routing uses active native search, authenticated registry
  OpenAI/Codex search, Exa, then paced Brave; only one visible alternative is
  allowed for safe availability-like failures. Parallel and official X remain
  explicit.
- Hard constraints are capability-checked and post-filtered where required;
  unsupported constraints are rejected rather than silently dropped.
- `web_search` source enrichment and `web_research` use the shared bounded,
  SSRF-safe local fetcher.
- Pi 0.84 `ProviderHeaders` null deletion semantics are supported by the
  internal contracts and provider header merges.

The fetch plane is local and bounded: pinned DNS/SSRF and redirect validation,
streamed response limits, cancellation/deadlines, Readability/Turndown,
Markdown/text/JSON, local AnyDoc document/PDF conversion, explicit page-bounded
`pdftotext`, and caption-only `yt-dlp`. `@firecrawl/anydoc@0.1.6` runs in a
worker inside `web_fetch`, converting DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP,
RTF, EPUB, CSV, and default text-based PDFs to bounded untrusted Markdown.
Its coded failures, detected format, provenance, output bounds, timeout, and
caller cancellation remain inside the existing fetch contract. Explicit
`maxPages` keeps the bounded `pdftotext` path because AnyDoc 0.1.6 exposes no
page-range option.

## Completed correction

The Pi-subagents session produced repeated pre-execution validation failures for
`web_search.contentResults` values of 4–5 against the old maximum of 3, and
`web_fetch.maxLength` of 20,000 against the old maximum of 12,000; corrected
calls then succeeded. These were not provider billing controls: source
enrichment and fetch length mainly affect local network/latency and model
context, while rejecting a call can create an extra model turn.

Commits `6f171a4` and `d47d0b8` remove those arbitrary small caps without
removing the real resource owners. Search enrichment accepts 1–20 pages,
matching the public search-result bound, and up to 32,000 requested characters
per page. Direct fetch accepts up to 32,000 requested characters, while its
hard 32-KB byte bound, response-size limit, timeout, cancellation, SSRF, and
output render bounds remain. Search and research stop optional source fetching
when their global model-visible output budget can no longer retain another
page; fetch paging stops at its accepted offset limit with an explicit warning.
Search still bounds model-visible output at 45 KB and fetch at 48 KB; invalid
requests are rejected rather than silently clamped. The tool schemas now
expose defaults and mirror runtime offset bounds. Parallel sends its requested
result count through `advanced_settings.max_results`.

## Decisions in force

- Do not run provider-comparison calls. Use source and authoritative
  documentation for portfolio decisions; live calls are deliberate,
  credential-gated correctness smoke tests only.
- Prefer authenticated native OpenAI/Codex search when Pi already has a
  compatible registry model, including cross-provider selection. Report the
  execution model and billing-relevant metadata.
- Normal automatic search is bounded to one primary plus one visible
  availability-like alternative. No hidden retries, paid fan-out, or fallback
  after outcome-unknown network/timeout/post-dispatch failures.
- Provider answers are optional, typed, cited, bounded, and untrusted. Evidence
  and provenance remain the public source of truth.
- Source enrichment is explicit and local. AnyDoc is local document conversion,
  not the hosted Firecrawl service; browser rendering, remote extraction,
  persistent cache/history, and curator storage remain deferred until a
  concrete workflow requires them.
- Keep exactly three public tools. Do not add providers merely for count or
  preserve third-party behavior that conflicts with cost, safety, or evidence
  policy.

## Verification

`bun run check` passes under Pi 0.84 dependencies: 186 tests, 444 assertions,
and clean TypeScript. The focused bound/Parallel tests, review probes, and
`git diff --check` also pass. The AnyDoc fixtures cover DOCX/PPTX/XLSX/ODT/RTF/EPUB/CSV/PDF,
malformed/unsupported conversion, octet-stream dispatch, HTML preservation,
and cancellation. The Pi 0.84 null-header fix has dedicated model-selection
and OpenAI tests. AnyDoc now owns default PDF conversion; explicit `maxPages`
retains bounded `pdftotext` because AnyDoc 0.1.6 exposes no page-range option.
Credential-gated live rows remain separate from the offline suite; prior
single-call smokes covered Codex, Exa, xAI web/X, Gemini Lite, and direct fetch,
with constrained xAI X no-citation behavior correctly rejected.

## Active tasks

- No blocking implementation task remains.
- `pi-search-3jx8`: investigate browser/Chrome MCP as a separate extension,
  not part of pi-search's default fetch path.

## Next sequence

1. Keep the current three-tool runtime stable and restart Pi after refreshes.
2. Run deliberate live provider correctness smoke only when credentials and a
   concrete workflow justify the cost.
3. Reopen browser/Chrome or richer official-X thread/lookup work only when a
   required workflow demonstrates that direct local fetch and current explicit
   providers are insufficient.
