# Architecture

## Runtime boundary

`src/index.ts` owns Pi registration and constructs provider adapters from
credentials and policy. `src/search-tool.ts`, `src/fetch-tool.ts`, and
`src/research-tool.ts` translate Pi tool calls into provider-neutral contracts
and bounded model-visible output.

## Search path

`src/contracts.ts` defines requests, evidence, capabilities, usage, rate-limit
metadata, and normalized errors. `src/router.ts` selects exactly one provider
using the active Pi model, explicit hints, capability constraints, and billing
policy. `src/search.ts` validates requests, combines caller cancellation with a
hard deadline, and maps failures to stable tool errors.

Provider adapters normalize their own HTTP or model-mediated payloads:

- `openai.ts`: OpenAI and Codex Responses search, SSE parsing, model-registry
  auth, citation/source normalization;
- `gemini.ts`: Google Search grounding;
- `xai.ts`: xAI web and X grounding;
- `brave.ts`: keyword/freshness/domain search and quota observations;
- `exa.ts`: semantic search, highlights, domains, and reported cost; and
- `parallel.ts`: objective-oriented search and bounded excerpts;
- `x.ts`: explicit official X recent search with post-level evidence.

## Fetch path

`src/ssrf.ts` validates and manually follows HTTP(S) redirects while pinning a
validated public DNS address. `src/direct-transport.ts` connects to that
address while preserving Host/SNI. `src/http.ts` and `src/fetcher.ts` enforce
streamed byte/deadline/cancellation bounds. HTML extraction runs in the local
worker at `src/fetch-extractor-worker.mjs`; PDF and YouTube paths use bounded
local subprocesses.

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
next gates are OpenAI/Codex correctness, direct fetch/PDF efficiency, Brave
free-mode admission, and a provider-role evaluation harness. Browser rendering,
remote extraction, persistent caches, media analysis, and extra overlapping
providers remain conditional on measured workflows rather than permanently
excluded.
