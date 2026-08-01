# Provider consolidation and fetch plan

Status: proposed. This is a planning surface, not an implementation contract
until reconciled with source and accepted by the project owner.

## Goals

- Cover useful native and direct search providers without duplicating calls by
  default.
- Preserve evidence, provenance, hard constraints, cost, and rate-limit
  metadata.
- Make page fetching produce clean, bounded, untrusted evidence with one clear
  safety and cancellation boundary.
- Reuse mature code where it reduces risk, without importing incompatible
  fallback chains or heavyweight dependencies.

## Phase 0 — establish the matrix

1. Audit each candidate provider's current API, auth source, cost model,
   freshness/domain/social capabilities, citation shape, and response limits.
2. Mark each capability as guaranteed, hinted, post-filterable, or unsupported.
3. Add explicit live smoke scripts for providers whose credentials are present;
   keep fixtures and live calls separate.
4. Decide which provider additions materially improve coverage over the shipped
   OpenAI/Codex, Gemini, xAI web/X, Brave, Exa, and Parallel adapters.

## Phase 1 — harden the shared evidence pipeline

1. Keep provider adapters responsible for request construction and payload
   parsing; keep normalization and tool bounds at shared boundaries.
2. Add a single result-cleanup layer for URL canonicalization, hostname/domain,
   title/excerpt bounds, duplicate URLs, timestamps, and source IDs. Preserve
   the raw source URL when canonicalization changes it.
3. Expose warnings for partial or hinted semantics; reject unsupported hard
   constraints before network access.
4. Add provider capability metadata for social/X, native grounding, content
   extraction, and cost/usage rather than adding vendor-specific branches to
   the router.

## Phase 2 — optimize individual-page fetching

1. Keep pinned direct HTTP, SSRF, redirect, byte, deadline, cancellation, and
   untrusted-content fencing as the default path.
2. Prefer content negotiation (`text/markdown`) when safe, then plain text,
   JSON/XML, HTML Readability/Turndown, and bounded raw fallback. Report the
   actual format and extraction path.
3. Keep PDF and caption extraction local and bounded. Add optional browser/JS
   rendering only behind an explicit opt-in with separate dependency, timeout,
   resource, privacy, and SSRF review.
4. Consider bounded content caching only after a concrete repeated-fetch need;
   make cache identity, TTL, size, invalidation, and privacy explicit.

## Phase 3 — selective provider additions

Prioritize only after Phase 0:

- native Anthropic/Claude bridge/ZAI if their auth and evidence can fit the
  current context boundary;
- SearXNG or DuckDuckGo if a keyless/local fallback is required and its output
  can be normalized safely; and
- Perplexity/Tavily/other direct APIs only when they add distinct coverage and
  explicit billing controls.

X/social search remains a capability, not a separate universal tool. xAI X is
already explicit; add another social provider only with stable source URLs,
citations, cost, and rate-limit evidence.

## Non-goals

Do not import automatic provider fallback, paid retries, provider fan-out,
opaque answer synthesis, browser curator/storage, GitHub cloning, telemetry,
or a multi-agent research planner into the default path.

## Decision gate

Before implementation, compare the provider matrix and fetch design against
`docs/DESIGN.md`, `docs/provider-policy.md`, deterministic tests, and the live
Pi configuration. Any copied MIT code must be added to
`THIRD_PARTY_NOTICES.md`.
