# pi-search

A standalone, provider-neutral web search extension for Pi.

> **Status:** scaffold only. The extension currently registers no tools.

## Scope

The extension will provide three focused tools:

- `web_search` — return structured search evidence and provenance.
- `web_fetch` — retrieve and extract content from a selected URL safely.
- `web_research` — an explicit, bounded multi-step workflow for difficult or
  multi-hop questions.

Providers will be adapters behind a shared contract. The initial target set is
Exa, Brave, Gemini, Parallel, and xAI, each selected for a distinct retrieval
niche. No provider will be treated as universally best. Routing will be based
on the task profile, provider capabilities, operational estimates, and explicit
cost/latency limits rather than an unconditional fan-out or a permanent vendor
ranking.

In-content matching is an internal fetch/research helper, not a fourth public
tool. Browser automation and remote extraction services remain out of the
first implementation.

## Design principles

- **Evidence first:** preserve URLs, excerpts, dates, provider identity, and
  request metadata so the calling model can inspect and cite sources.
- **One provider by default:** multi-provider search is opt-in or reserved for
  `web_research`; ordinary lookups should be fast and bounded.
- **Role-aware routing:** general, fresh, technical, semantic, deep-research,
  social, and known-URL tasks can use different providers.
- **Safe fetching:** enforce timeouts, redirect checks, response limits, and
  SSRF protections; treat fetched pages as untrusted content. The first fetch
  path uses direct HTTP and local extraction only; a remote extractor would
  require a separate explicit opt-in contract.
- **Small core:** provider adapters should not leak vendor-specific response
  shapes into the Pi tools.
- **No telemetry:** credentials stay in the user's environment and the
  extension does not add analytics or remote state.

## Delivery order

1. Establish normalized contracts, execution context, hard-option reporting,
   provider profiles, and research budgets.
2. Add a useful single-provider `web_search` with the Exa adapter.
3. Add bounded direct URL fetching with local safe extraction.
4. Add capability-aware provider adapters and role-based routing.
5. Add budget-enforced `web_research` only after the first two tools have
   stable contracts.

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

The implementation plan and design decisions are tracked in
[`docs/implementation-plan.md`](docs/implementation-plan.md). The first vertical slice adds one provider
adapter and one direct fetch path, then grows only when a concrete agent task
requires another capability.

## License

MIT
