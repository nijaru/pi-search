# Architecture

## Runtime boundary

`src/index.ts` owns Pi registration and constructs provider adapters from
credentials and policy. `src/search-tool.ts`, `src/fetch-tool.ts`, and
`src/research-tool.ts` translate Pi tool calls into provider-neutral contracts
and bounded model-visible output.

## Search path

`src/contracts.ts` defines requests, evidence, capabilities, usage, rate-limit
metadata, and normalized errors. `src/router.ts` selects exactly one provider
using the active Pi model, explicit hints, hard capability constraints, and
billing policy. `src/model-selection.ts` resolves an active or explicitly
requested compatible Gemini, xAI, or OpenAI/Codex model through the supplied Pi
registry; it never reads auth state globally. `src/search.ts` validates
requests, combines caller cancellation with a hard deadline, and maps failures
to stable tool errors. Public result defaults stay provider-neutral; provider
adapters translate the requested result cap into their own documented request
fields rather than relying on provider defaults.

Provider adapters normalize their own HTTP or model-mediated payloads:

- `openai.ts`: OpenAI and Codex Responses search, SSE parsing, model-registry
  auth, citation/source normalization;
- `gemini.ts`: Google Search grounding, support-linked citations, and explicit model selection;
- `xai.ts`: xAI web and X grounding, documented handle/date/media options, and explicit model selection;
- `brave.ts`: keyword/freshness/domain search and quota observations;
- `exa.ts`: semantic search, highlights, domains/date ranges, and reported cost; and
- `parallel.ts`: objective-oriented search and bounded excerpts with explicit constraint rejection;
- `x.ts`: explicit official X recent search with post-level evidence, OR-grouped handle filters, and date ranges.

## Fetch path

`src/ssrf.ts` validates and manually follows HTTP(S) redirects while pinning a
validated public DNS address. `src/direct-transport.ts` connects to that
address while preserving Host/SNI. `src/http.ts` and `src/fetcher.ts` enforce
streamed byte/deadline/cancellation bounds. HTML extraction runs in the local
worker at `src/fetch-extractor-worker.mjs`; YouTube and explicit page-bounded
PDF requests use bounded local subprocesses. `@firecrawl/anydoc@0.1.6` handles
local office/document and default PDF conversion through `src/anydoc.ts` and
`src/anydoc-worker.mjs`; it is not a second extension or hosted Firecrawl
integration. AnyDoc's PDF path uses its bundled `pdf-inspector` parser for
structured Markdown. The AnyDoc worker owns native binding/conversion lifetime,
while `fetcher.ts` owns response limits, cancellation/deadlines, provenance,
output bounds, and the untrusted-content contract. The fetcher accepts up to
32,000 requested characters per page, but its hard 32-KB output-byte bound and
model-visible renderer bound remain authoritative. Search enrichment reuses
that fetch contract, with a finite page count tied to the public result bound
and a separate 45-KB search output budget.

## Extension migration

The active Pi package list now contains one web extension: pi-search. The
required workflow inventory is recorded in
`ai/research/required-workflows.md`; it requires core evidence/search/fetch/
research workflows but assigns reference-package extras to Pi/Bash or defers
them until a concrete need appears. A running Pi process must restart after a
package-list change before it observes the sole-owner runtime.

## Planned evolution

The long-term target is a portfolio of best-in-class providers by capability,
not a single vendor or a large adapter count. Ordinary calls remain
single-provider and evidence-first; explicit provider selection and a future
opt-in comparison mode may use multiple providers without hidden fan-out.

Provider-landscape research should add only capabilities that materially improve
coverage, quality, cost, freshness, filtering, social retrieval, or context
usability. New adapters and fetch layers must implement the existing contracts,
preserve request constraints and provenance, expose costs/limits where
available, and include offline fixtures plus explicit live smoke coverage. The
remaining gates are live provider correctness, direct fetch/PDF quality, and
provider-role review. Browser rendering, remote extraction, persistent caches,
media analysis, richer X lookup/thread support, and extra overlapping providers
remain conditional on measured workflows rather than permanently excluded.
`@firecrawl/anydoc` is shipped as a local document-conversion layer and does not
imply remote extraction.
