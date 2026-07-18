# pi-search

A standalone, provider-neutral web search extension for Pi.

> **Status:** scaffold only. The extension currently registers no tools.

## Scope

The eventual extension will provide three focused tools:

- `web_search` — return structured search evidence and provenance.
- `web_fetch` — retrieve and extract content from a selected URL safely.
- `web_research` — an explicit, bounded multi-step workflow for difficult or
  multi-hop questions.

Providers will be adapters behind a shared contract. Initial adapters may
cover native model search, Brave, Exa, Parallel, Gemini, Tavily, xAI, and
free/degraded fallbacks, but no provider will be treated as universally best.
Routing will be based on the task profile and provider capabilities rather than
an unconditional fan-out or a permanent vendor ranking.

## Design principles

- **Evidence first:** preserve URLs, excerpts, dates, provider identity, and
  request metadata so the calling model can inspect and cite sources.
- **One provider by default:** multi-provider search is opt-in or reserved for
  `web_research`; ordinary lookups should be fast and bounded.
- **Role-aware routing:** general, fresh, technical, semantic, deep-research,
  social, and known-URL tasks can use different providers.
- **Safe fetching:** enforce timeouts, redirect checks, response limits, and
  SSRF protections; treat fetched pages as untrusted content.
- **Small core:** provider adapters should not leak vendor-specific response
  shapes into the Pi tools.
- **No telemetry:** credentials stay in the user's environment and the
  extension does not add analytics or remote state.

## Delivery order

1. Establish normalized contracts and a useful single-provider `web_search`.
2. Add bounded direct URL fetching with safe extraction.
3. Add capability-aware provider adapters and role-based routing.
4. Add `web_research` only after the first two tools have stable contracts.

Cross-provider combination, caching, and specialized fetchers should be added
only when a concrete task justifies them. An independent evaluation project can
consume the provider contracts separately without becoming part of the Pi
runtime package.

## Non-goals

This is not a browser automation framework, a general-purpose crawler, a
search-result answer engine, or a hidden replacement for Pi's model routing.
It will not query every configured provider for every request, and it will not
include a benchmark harness in the extension itself.

## Development

```bash
bun install
bun run check
```

The first implementation should establish normalized request/result contracts,
add one provider adapter and one fetch path, then grow only when a concrete
agent task requires another capability.

## License

MIT
