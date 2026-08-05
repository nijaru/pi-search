# pi-search implementation plan

This is the tracked source of truth for implementation order.

## 0. Contracts and design gate — complete

- Public boundary is `web_search`, `web_fetch`, and `web_research`.
- Model/auth execution context is explicit.
- Provider profiles, capabilities, usage metadata, hard-option reporting, and
  research budgets are defined and tested.
- Direct fetching is local; remote extraction is not implicit.

## 1. Cost-controlled `web_search` — complete

- Native OpenAI/Codex Responses search is the first route for compatible active
  models and for authenticated same-provider models available in Pi's registry
  when another model is active.
- Exa is the automatic non-native path when `EXA_API_KEY` is configured;
  Brave remains a paced last-resort keyword path.
- Automatic routing permits one visible fallback only after an authentication,
  rate-limit, or unavailable failure known not to have produced a billable
  result; explicit provider hints never fall through.

## 2. Direct `web_fetch` — complete

- Direct HTTP fetching uses pinned DNS, SSRF and redirect checks, streamed
  byte limits, local Readability/Turndown extraction, one deadline,
  cancellation, and untrusted-content fencing.
- PDF URLs use bounded local `pdftotext`.
- YouTube URLs use bounded local captions-only `yt-dlp`.
- Local office/document conversion through `@firecrawl/anydoc` is planned
  inside `web_fetch`; no hosted Firecrawl service or separate extension.

## 3. Capability-aware routing — complete

Shipped routing now covers:

- OpenAI Responses and Codex Responses native search;
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

Before adding the other adapters, the OpenAI/Codex path was hardened with:

- strict Responses API compatibility checks;
- LF and CRLF SSE parsing;
- required terminal completion events;
- rejection of truncated/incomplete streams;
- request ID and retry-after preservation; and
- regression tests for auth, cancellation, malformed responses, HTTP errors,
  and unsupported constraints.

## 6. Additional providers — complete for the current release

- Exa semantic search with highlights, domains, request IDs, and reported cost.
- Parallel Search API objective/excerpt normalization with explicit domain
  limitation.
- Gemini grounding source extraction through Pi model-registry auth.
- xAI web grounding and semantic X grounding through the Responses API.
- Official X recent search with direct post evidence and explicit provider
  routing.
- Explicit provider schemas and routing tests for local/non-native workflows.

## 7. Post-install maturity gates — next work

The tools now emit bounded readable model content, typed cited native answers,
optional bounded source enrichment, explicit model selection for model-mediated
search, and compact default Pi renderers; expanded views retain the structured
details. The remaining gates below are about live provider correctness and
complete Pi execution, not adding more output formats.

The package is installed and usable, but these are the correct next gates
before calling the search surface production-mature:

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
   handles/media controls are now typed and enforced only by providers that
   document them (Exa/X and xAI X). Unsupported hard constraints are rejected
   at both routing and adapter boundaries. Source-type filters and richer
   provider-specific controls remain deferred; normal calls remain
   single-provider and comparison/fan-out is never hidden behavior.

### Next planned integration — local document conversion

Task: `pi-search-obe3` (open, deliberately unstarted).

`@firecrawl/anydoc` is a local Rust/N-API library that converts DOC/DOCX,
PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF, EPUB, CSV, and PDF to GitHub-Flavored
Markdown. It is useful agent functionality and belongs behind the existing
`web_fetch` boundary, not in a separate extension. Keep the package name
`pi-search`; document conversion is an extraction capability alongside HTML,
PDF, and YouTube handling.

Planned order:

1. Add a pinned `@firecrawl/anydoc` dependency and verify the native package on
   the current Node/Bun platform.
2. After the existing safe byte read, detect supported document bytes/content
   types and convert non-HTML documents to bounded untrusted Markdown. Preserve
   source URL, content type, byte count, extraction metadata, output bounds,
   cancellation, and error mapping.
3. Add deterministic representative fixtures for DOCX/PPTX/XLSX/ODT/RTF/EPUB/
   CSV and error cases. Use the same path for `web_search` source enrichment and
   `web_research` through `fetchContent`.
4. Compare representative anydoc PDF Markdown with current `pdftotext` before
   changing PDF ownership. Do not require a drop-in replacement; retain either
   path based on actual usefulness and operational behavior.

Acceptance: remote document URLs work through `web_fetch` with no API key or
hosted service; the public tool set remains exactly three tools; direct HTML,
Markdown, text, JSON, YouTube, and the current PDF path remain correct; no
hard constraints or trust/provenance metadata are lost; and Bun checks plus a
clean Pi pnpm install pass.

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
