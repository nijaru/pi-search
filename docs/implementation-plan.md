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
  models.
- Brave is available for other/local models only with explicit free-capacity or
  metered policy.
- No native failure falls through to Brave or a paid provider.

## 2. Direct `web_fetch` — complete

- Direct HTTP fetching uses pinned DNS, SSRF and redirect checks, streamed
  byte limits, local Readability/Turndown extraction, one deadline,
  cancellation, and untrusted-content fencing.
- PDF URLs use bounded local `pdftotext`.
- YouTube URLs use bounded local captions-only `yt-dlp`.

## 3. Capability-aware routing — complete

Shipped routing now covers:

- OpenAI Responses and Codex Responses native search;
- Gemini Google Search grounding;
- xAI web grounding and explicit X grounding;
- Brave for free-capacity or explicitly metered non-native use; and
- explicit, metered Exa and Parallel adapters.

Native and direct failures remain visible. There is no hidden retry, fallback,
or provider fan-out.

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
- Official X recent search with direct post evidence and explicit metered
  routing.
- Explicit provider schemas and routing tests for local/non-native workflows.

## 7. Post-install maturity gates — next work

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
3. **Brave free-mode admission gate.** Add a concurrency-safe local limiter,
   preserve provider-reported quota windows, and state clearly that monthly
   free credits are account billing rather than a separate endpoint or local
   billing guarantee.
4. **Provider-role evaluation gate.** Build deterministic and credential-gated
   comparisons for quality, freshness, constraints, excerpts/context,
   latency, cost, quotas, provenance, and failure behavior. The result should
   choose providers by capability, not create a universal vendor ranking.
5. **Explicit option gate.** Add date, source-type, social-handle, or other
   provider-neutral options only when the evaluation shows a required gap.
   The current contract stays intentionally small: X query operators can be
   passed through the query, while generic date/social fields wait for a
   provider implementation and a second conformance fixture. Normal calls
   remain single-provider; comparison/fan-out is a future explicit mode, never
   hidden behavior.

### Long-term selective additions

- Add the official X API as an explicit complementary provider for exact post,
  query, user, and date/archive workflows; keep xAI `x_search` for
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
xAI, Brave, Exa, and Parallel live rows are marked skipped because dedicated
credentials are not available, not because their behavior was guessed.

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
- Persistent search history, hidden answer synthesis, and telemetry.
- Live provider calls in the default test suite. Credential-gated smoke tests
  remain an operational release check because they consume quotas or money.
