# pi-search implementation plan

This is the tracked source of truth for implementation order. `handoff.md` is
local session context and may summarize this file, but it is intentionally
ignored by git.

## 0. Contracts and design gate — complete

- Keep the public boundary at `web_search`, `web_fetch`, and `web_research`.
- Carry model/auth execution context explicitly through `Provider.search`.
- Require provider profiles and preserve actual usage metadata when available.
- Make unsupported search options visible; never silently drop hard filters.
- Define and validate `ResearchBudget` before orchestration.
- Keep direct fetching local; do not add Jina or another remote extractor to
  the first slice.

Exit evidence: `src/contracts.ts` and deterministic tests cover these rules;
`bun run check` passes. The tracked design is in `docs/DESIGN.md`.

## 1. First vertical slice: `web_search` + Exa

Implement the Pi registration and Exa adapter together.

Acceptance criteria:

- `src/index.ts` registers only `web_search`.
- The tool validates query and result limits, propagates cancellation, and
  applies a bounded timeout.
- The adapter uses `EXA_API_KEY` supplied through its explicit construction
  path and never logs the key.
- Results are normalized to evidence fields and the provider-native answer is
  not requested by default.
- Domain/date options are either applied, explicitly warned about, or rejected
  before a request can violate a hard constraint.
- Auth, HTTP, rate-limit, malformed-payload, timeout, and cancellation errors
  map to stable tool-visible failures.
- Offline fixture tests cover normalization and error mapping. Live tests are
  credential-gated and opt-in.

## 2. Direct `web_fetch`

Implement direct HTTP fetching with the adapted SSRF and redirect guard from
`pi-web-access`, after verifying the code can be vendored under its license.
Add local readable extraction, content-type handling, response-size limits,
timeouts, cancellation, and untrusted-content fencing.

Every successful result must mark `FetchedContent.contentTrust` as
`"untrusted"` at the contract boundary.

If readable extraction fails, return bounded raw HTML with
`fellBackToRaw: true`. Do not call a remote extraction service implicitly.

Tests must cover private and link-local targets, IPv4/IPv6 and mapped IPv6,
redirect revalidation, size limits, non-HTML responses, extraction fallback,
and cancellation without requiring network access by default.

## 3. Capability-aware routing and remaining adapters

Add the router only after the first search and fetch paths have stable
contracts. It must use capability and profile metadata, honor explicit
latency/cost limits, and select one provider for ordinary search.

Add Brave, Gemini, Parallel, and xAI one at a time. Each adapter gets offline
fixtures, explicit auth/availability behavior, and a credential-gated live
smoke test. Parallel belongs primarily in the research workflow; xAI and
Gemini use the model-registry execution context.

## 4. Budgeted `web_research`

Implement the research tool after `web_search` and `web_fetch` are stable.
Require and validate `ResearchBudget`, use one overall deadline, count every
provider call and step, and require a provider cost estimate whenever a cost
ceiling is requested. Reserve estimates before calls and reconcile them with
reported usage when available. Return warnings for partial completion.
Multi-provider work must be explicit in the request; hidden fan-out and
cross-provider retries are not allowed.

## Deferred

- Public `web_find` or `web_browse` tools.
- Browser automation, crawling, video, and GitHub cloning.
- Remote extraction services and provider fan-out for ordinary search.
- Benchmarking inside this runtime package; use a separate evaluation project.
