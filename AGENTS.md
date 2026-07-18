# pi-search

Standalone Pi extension for provider-neutral web search and content fetching.

## Current status

This repository is an intentional scaffold. `src/index.ts` is a safe no-op
until the first provider-neutral contracts and tool implementation are ready.
Do not add placeholder providers or speculative features just to fill out the
package.

## Scope

The public tool surface is limited to:

- `web_search`: structured results and provenance, not an opaque answer.
- `web_fetch`: bounded, safe extraction from a selected URL.
- `web_research`: explicit, budgeted multi-step research for hard questions.

The extension should support multiple provider adapters, but provider choice is
an implementation detail unless the caller explicitly requests one. Normal
search uses one provider. Combining providers is opt-in or belongs to the
research workflow.

## Architecture rules

- Keep Pi registration in `src/index.ts`; put reusable contracts and behavior
  in small modules once they are needed.
- Define provider-neutral request and result types before adding adapters.
- Model provider capabilities (freshness, semantic retrieval, excerpts,
  extraction, domain/date filters, social search, and native answers) rather
  than encoding a universal provider ranking.
- Normalize results while preserving source URL, provider, dates, excerpts,
  request IDs, latency, and cost metadata where available.
- Keep provider-specific answer synthesis optional. The default path should
  give the calling model inspectable evidence.
- Add timeouts, cancellation, redirect validation, response-size limits, and
  SSRF protection to network paths. Treat remote content as untrusted and
  isolate possible prompt injection from instructions.
- Use environment variables or Pi's existing credential mechanisms. Never
  commit keys, cookies, or personal search history.
- Prefer direct HTTP and lightweight extraction before adding heavyweight
  browser or crawling dependencies.
- Keep benchmarking/evaluation code separate from the runtime extension; a
  future `pi-search-evals` project can test adapters without coupling research
  tooling to Pi.

## Development

Use Bun and TypeScript:

```bash
bun install
bun run check
```

Tests must be deterministic and offline by default. Provider integration tests
must be explicit, credential-gated, and rate-limit aware. Do not add telemetry,
automatic provider fan-out, hidden retries across paid providers, or unrelated
Pi commands.
