# pi-search implementation plan

This is the tracked source of truth for implementation order.

## 0. Contracts and design gate — complete

- Public boundary is `web_search`, `web_fetch`, and `web_research`.
- Model/auth execution context is explicit.
- Provider profiles, capabilities, usage metadata, hard-option reporting, and
  research budgets are defined and tested.
- Direct fetching is local; remote extraction is not implicit.

## 1. Cost-controlled `web_search` — complete

- Native OpenAI Responses search and standalone Codex `alpha/search` are the
  first routes for compatible active models and for authenticated same-provider models available in Pi's registry
  when another model is active.
- Exa is the automatic non-native path only when metered search is allowed;
  `PI_SEARCH_PREFER_FREE=1` prefers admitted Brave before Exa, while free-only
  mode keeps Exa explicit and Brave paced.
- Automatic routing permits one visible fallback only after an authentication,
  rate-limit, or unavailable failure known not to have produced a billable
  result; explicit provider hints never fall through.

## 2. Direct `web_fetch` — complete

- Direct HTTP fetching uses pinned DNS, SSRF and redirect checks, streamed
  byte limits, local Readability/Turndown extraction, one deadline,
  cancellation, and untrusted-content fencing.
- PDF URLs use pinned local `@firecrawl/anydoc`/`pdf-inspector` conversion
  for structured Markdown. Explicit `maxPages` requests retain bounded local
  `pdftotext` because AnyDoc has no page-range option; OCR is not
  implicit.
- YouTube URLs use bounded local captions-only `yt-dlp`.
- DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV, and PDF
  conversion uses pinned local `@firecrawl/anydoc` inside `web_fetch`; no
  hosted Firecrawl service or separate extension.

## 3. Capability-aware routing — complete

Shipped routing now covers:

- OpenAI Responses web search and Codex standalone `alpha/search`;
- Gemini Google Search grounding, including explicit registry model selection;
- xAI web grounding and explicit X grounding, including bounded X handle/date/
  media constraints and registry model selection;
- Exa for configured non-native semantic search;
- Brave for free-capacity or explicitly metered last-resort keyword search; and
- explicit, metered Parallel and official X adapters.

Native and direct failures remain visible. Automatic routing has at most one
visible alternative for safe rejected/unavailable failures; network, timeout,
and post-dispatch HTTP failures remain final because their effects are
uncertain. There are no same-provider retries, unbounded fallback, or provider
fan-out.

## 4. Budgeted `web_research` — complete

`web_research` accepts caller-supplied queries, selects one provider once, runs
sequentially, counts searches/fetches/steps, enforces one deadline, bounds
output, and reports partial completion. A cost ceiling is rejected when the
selected provider has no reliable per-call estimate.

## 5. OpenAI stability gate — complete

The OpenAI and Codex paths are hardened with:

- strict OpenAI Responses compatibility checks;
- official Codex `alpha/search` request/response mapping;
- LF and CRLF SSE parsing for OpenAI;
- required terminal completion events and rejection of truncated streams;
- request ID, citation-range, usage, and retry-after preservation; and
- regression tests for auth, cancellation, malformed responses, HTTP errors,
  hard constraints, and provider-specific controls.

## 6. Additional providers — complete for the current release

- Exa semantic search with highlights, domains, request IDs, and reported cost.
- Parallel Search API objective/excerpt normalization with explicit domain
  limitation.
- Gemini grounding source extraction through Pi model-registry auth.
- xAI web grounding and semantic X grounding through the Responses API.
- Official X recent search with direct post evidence and explicit provider
  routing.
- Explicit provider schemas and routing tests for local/non-native workflows.

## 7. Post-install maturity gates — offline gate complete

The tools emit bounded readable model content, typed cited native answers,
optional bounded source enrichment, explicit model selection for model-mediated
search, and compact default Pi renderers; expanded views retain structured
details. The offline architecture gate now covers OpenAI Responses and Codex
`alpha/search` request/response behavior, hard controls, citation alignment,
timeout classification, and independent research fetch budgets.

The remaining gates are credentialed/live validation and representative fetch
quality, not additional runtime surface:

1. **OpenAI/Codex production gate.** Audit current Responses behavior, source
   citation fidelity, model/auth selection, hard constraints, cancellation,
   incomplete streams, usage, and rate-limit diagnostics. Run explicit live
   smoke cases for both OpenAI and Codex when credentials are available.
2. **Direct fetch/PDF quality gate.** Exercise representative HTML, Markdown,
   text, JSON, redirects, oversized responses, readable extraction, PDFs, and
   explicit scanned/encrypted failures. Keep the direct local path as the
   efficient default; do not add a browser or remote extractor by habit.
3. **Direct-provider correctness gate.** Verify Exa's automatic non-native
   route, bounded fallback diagnostics, source enrichment, and strict explicit
   provider behavior. Do not run comparison calls merely to rank providers;
   use existing source/docs research for portfolio decisions.
4. **Brave free-mode admission gate.** Preserve provider-reported quota
   windows and state clearly that monthly free credits are account billing,
   not a separate endpoint or local billing guarantee. Do not treat the local
   1 RPS limiter as proof of free capacity.
5. **Provider-specific option gate.** Date ranges and bounded social/X
   handles/media controls are typed and enforced only by providers that
   document them (Exa/X and xAI X). OpenAI and Codex native context size,
   location, live-access, and source-type/image controls are mapped only on
   their compatible adapters. Unsupported hard constraints are rejected at
   both routing and adapter boundaries; normal calls remain single-provider
   and comparison/fan-out is never hidden behavior.

### Completed integration — local document conversion

Task: `pi-search-obe3` (implemented in the existing `web_fetch` boundary).

Pinned `@firecrawl/anydoc@0.2.4` runs in a worker and converts DOC/DOCX,
PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV, and PDF to GitHub-Flavored
Markdown. Format detection uses document signatures, served content types, and
safe URL extensions. Explicit `maxPages` requests use bounded `pdftotext`
because AnyDoc has no page-range option; default PDF conversion uses AnyDoc's
structured `pdf-inspector` path. The worker boundary preserves caller
cancellation and the fetcher's timeout, while coded converter failures map to
stable fetch errors with the AnyDoc code in the bounded diagnostic.

Deterministic fixtures cover DOCX/PPTX/XLSX/ODT/RTF/EPUB/CSV/PDF, including an
`application/octet-stream` document path, malformed/unsupported failures, and
conversion timeout cancellation. The same `fetchContent` path serves
`web_search` source enrichment and `web_research` fetches. Results retain the
final/source URL, served content type, byte count, output bounds, content trust,
extraction path, and detected document format.

Acceptance is met when `bun run check` passes and a clean Pi pnpm install can
resolve the pinned native package on the active platform; no hosted service or
new public tool is involved.

### Long-term selective additions

- Expand the official X API only if exact post lookup, user timelines, or
  date/archive workflows become required; keep xAI `x_search` for
  semantic/model-mediated social context.
- Add Perplexity only if hard date/path/domain controls materially improve a
  required workflow beyond the shipped set.
- Consider SearXNG only for an explicit self-hosted/privacy requirement.
- Consider Tavily, Anthropic native search, or remote extraction only when a
  measured quality or ownership gap justifies their cost and auth complexity.
- Reopen browser/JS rendering, OCR, media analysis, caching, or provider
  fan-out only with a representative workflow, resource/privacy review, and
  explicit contract.

Existing deferred features are hypotheses, not permanent exclusions. The
provider landscape and evaluation results decide whether they move into the
runtime.

## 8. Sole replacement gate — complete with credential caveats

The required workflow classification is recorded in
`ai/research/required-workflows.md`. The shared hard-constraint, metadata,
trust-fence, and Codex smoke fixes are complete. Offline fixtures cover every
required row; a fresh Pi Codex call and installed registration passed. Gemini,
xAI, Brave, Exa, Parallel, and official X API live rows are marked skipped
because dedicated credentials are not available, not because their behavior
was guessed.

`pi-web-access` has been removed from the active Pi package list. Restart an
existing Pi process before relying on the cutover.

## Deferred / outside ownership until the needs inventory says otherwise

These are current boundaries, not permanent exclusions. They remain outside
until a required workflow demonstrates that pi-search must own them:

- Browser automation, crawling, remote extraction, and provider fan-out.
- Video downloads, frames, visual analysis, and OCR. Use Bash, `yt-dlp`,
  `ffmpeg`, or a dedicated vision workflow.
- Local filesystem/repository operations and implicit GitHub cloning. Use
  `read`, Bash, `git`, and `gh`.
- Persistent search history, opaque answer synthesis, and telemetry. Typed
  provider-grounded answers with citations are part of the search contract.
- Live provider calls in the default test suite. Credential-gated smoke tests
  remain an operational release check because they consume quotas or money.
