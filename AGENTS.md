# pi-search

Standalone Pi extension for provider-neutral web search and content fetching.

## Current status

`src/index.ts` registers `web_search` and `web_fetch`; the explicit query-batch
`web_research` is opt-in. Architecture and remaining work live in
`docs/DESIGN.md` and `docs/implementation-plan.md`.
Do not add providers or speculative features merely to fill out the package.

## Scope

The public tool surface is limited to:

- `web_search`: structured results and provenance, not an opaque answer.
- `web_fetch`: bounded, safe extraction from a selected URL.
- `web_research`: optional bounded execution of caller-planned search/fetch batches.

The extension should support multiple provider adapters, but provider choice is
an implementation detail unless explicitly requested. Normal search stops at
one successful backend; sequential safe fallback is not provider fan-out.
Combining successful searches is opt-in or belongs to the research workflow.

## Architecture rules

- Preserve the registry's resolved routing in every selection path
  (`selectModelExecution` and the OpenAI adapter's own `selectSearchExecution`).
  The tool boundary must forward `baseUrl`/`env` from `getApiKeyAndHeaders`, and
  each selector applies the resolved base URL to the execution model so adapters
  honor a provider-owned endpoint override instead of falling back to catalog
  metadata.
- Let an explicit `authorization` entry (a value or a `null` deletion) win over a
  bearer synthesized from the API key.
- Keep Pi registration in `src/index.ts`; put reusable contracts and behavior
  in small modules once they are needed.
- Define provider-neutral request and result types before adding adapters.
- Model provider capabilities (freshness, semantic retrieval, excerpts,
  extraction, domain/date filters, social search, and native answers) rather
  than encoding a universal provider ranking.
- Normalize results while preserving source URL, provider, dates, excerpts,
  request IDs, latency, and cost metadata where available.
- Do not silently drop requested search constraints. Route around unsupported
  hard filters, post-filter only when semantics remain correct, or report an
  explicit warning/error.
- Keep model-mediated providers behind an explicit execution context carrying
  model selection and credential lookup; never read Pi auth state globally.
- Automatic routing follows active provider/API authentication, not model-name
  heuristics or unrelated cached logins. Explicit per-call overrides are strict.
  Search and research share one ordered plan executor; count every batch
  fallback attempt. Adapter preflight must stay pure and precede credential use.
- Keep provider summaries optional and excerpt text paired with its provenance.
  Pi owns synthesis.
- Add timeouts, cancellation, redirect validation, response-size limits, and
  SSRF protection to network paths. Treat remote content as untrusted and
  isolate possible prompt injection from instructions.
- Use environment variables or Pi's existing credential mechanisms. Never
  commit keys, cookies, or personal search history.
- Prefer direct HTTP and lightweight extraction before adding heavyweight
  browser or crawling dependencies.
- General fetching stays direct and local. X post/Article URLs are the reviewed
  exception: free FxTwitter is the disclosed, zero-configuration public default;
  do not prompt for every request. `/search-x direct` persistently opts out.
  Authorized browser reads take priority only after `/search-x connect`, reuse
  the user's existing login in an owned temporary tab, and never fall back to a
  public service on an authenticated failure. Never enable browser control,
  import cookies, instrument unrelated tabs, or change shared browser settings.
  Browser extraction is not the direct HTTP transport's DNS-pinned sandbox; keep
  its target-local controls and limitations explicit. Other remote extraction
  services still need a separate opt-in, privacy, cost, and SSRF review.
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
