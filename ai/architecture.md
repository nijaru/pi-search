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
- `parallel.ts`: objective-oriented search and bounded excerpts.

## Fetch path

`src/ssrf.ts` validates and manually follows HTTP(S) redirects while pinning a
validated public DNS address. `src/direct-transport.ts` connects to that
address while preserving Host/SNI. `src/http.ts` and `src/fetcher.ts` enforce
streamed byte/deadline/cancellation bounds. HTML extraction runs in the local
worker at `src/fetch-extractor-worker.mjs`; PDF and YouTube paths use bounded
local subprocesses.

## Extension coexistence

`pi-web-access` remains installed but its search registration is disabled in
`~/.config/pi/web-search.json`. This package owns the three public tool names;
its specialty functionality remains an explicit rollback option.

## Planned evolution

Provider-landscape research should add only capabilities that materially improve
coverage. New adapters must implement the existing contracts, preserve request
constraints and provenance, expose costs/limits where available, and include
offline fixtures plus explicit live smoke coverage. Browser rendering, remote
extraction, persistent caches, and multi-agent research remain opt-in design
questions rather than default dependencies.
