# pi-search design

## Public boundary

The extension exposes exactly three Pi tools:

- `web_search` returns normalized search evidence and provenance.
- `web_fetch` retrieves bounded content from a selected URL.
- `web_research` runs an explicit, budgeted multi-step workflow.

In-content matching is a reusable internal helper for fetched content and
research. It is not a public `web_find` tool. Browser automation and remote
extraction are deferred.

## Provider boundary

All providers implement the provider-neutral contract in
`src/contracts.ts`. Provider routing, billing policy, provider comparison, and
replacement scope are recorded in [`provider-policy.md`](provider-policy.md).
There are two implementation families:

- Direct HTTP providers: Exa, Brave, and Parallel.
- Model-mediated providers: OpenAI/Codex native Responses search, Gemini, and
  xAI, using the execution context's model registry for credentials and model
  headers.

The tool boundary supplies `ProviderContext`; adapters must not read Pi's
model registry, credentials, or other runtime state through globals. Direct
providers may ignore model context. The provider profile supplies advisory
latency, cost, and authentication metadata for routing; actual usage is
returned when the provider reports it.

Normal search selects one provider. When the active Pi model is OpenAI or
Codex, the custom tool uses that model's native Responses `web_search` first;
a failure is visible and never falls back to Exa. For other models, the future
policy is free-capacity first, then explicitly allowed metered capacity.
Cross-provider calls are permitted only inside an explicitly requested research
workflow. The policy never hides a paid fallback behind quota or transient
errors. Gemini and xAI remain explicit model-mediated paths, while Brave, Exa,
and Parallel are direct HTTP adapters.

## Constraint semantics

Search options are observable. Providers list applied options in the response
and report unsupported or partial options as warnings, or raise a normalized
`unsupported` error. A hard domain/date constraint must be routed to a capable
provider or applied by a semantically correct post-filter; it must never be
silently discarded.

## Fetch safety

The first fetch implementation uses a pinned direct HTTP transport, manual
redirect validation, DNS/IP SSRF checks, streamed response-size limits,
one overall deadline, cancellation, and local extraction. It does not trust
proxy resolution in the initial path. Fetched content is untrusted data and is
clearly fenced at the Pi tool boundary; `FetchedContent.contentTrust` is always
`"untrusted"`. Successful results report the produced format, extraction
method, redirect count, bytes read, and truncation state. If local extraction
fails, the fetcher may return bounded raw HTML only when the request permits
that fallback and marks the produced format accordingly.

Remote extraction services such as Jina are not part of the default path. Any
future remote extractor needs explicit opt-in plus a separate privacy, cost,
redirect, and SSRF review because the extension cannot inspect a third-party
fetcher's server-side redirects.

## Specialty coverage

X/social search, YouTube transcripts, PDFs, and GitHub repository exploration
are separate capability handlers, not hidden fallbacks from ordinary HTML
fetching. See [`provider-policy.md`](provider-policy.md) for the replacement
acceptance matrix and intentional non-goals.

## Research limits

`web_research` requires a `ResearchBudget` before making a provider call:

- positive `maxSteps`;
- positive `maxProviderCalls`;
- positive `timeoutMs`; and
- optional non-negative `maxCostUsd`.

The orchestrator validates the budget up front and stops at every limit. When a
cost ceiling is set, every selected provider must have a cost estimate; the
orchestrator reserves that estimate before a call and reconciles it with actual
usage when available. It reports completed steps, provider calls, usage, and
warnings. Provider fan-out is explicit and bounded; there are no hidden
retries across paid providers.

## Initial provider target

The initial target set is deliberately limited to six niches:

- OpenAI/Codex native search for the active model's subscription capability;
- Exa for semantic and technical retrieval;
- Brave for independent keyword retrieval, freshness, and latency;
- Gemini for Google-backed grounding;
- Parallel for multi-hop research;
- xAI for social/X retrieval.

This is a target set, not a promise that all six ship before the first useful
vertical slice. Providers without a distinct role remain deferred.
