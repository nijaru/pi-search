# Search-plane design

This is the implementation contract for the sole `pi-search` web extension.
It replaces the earlier evidence-only/native-active-only design.

## User-visible contract

`web_search` is a normal task tool, not a raw API dump:

- when the selected backend supplies a grounded answer, return that answer with
  bounded untrusted text and source citations;
- otherwise return concise, inspectable evidence with titles, URLs, excerpts,
  dates, and provider provenance;
- keep the normalized structured response in tool details and show a compact
  Pi renderer by default;
- never treat answer text, snippets, or fetched pages as instructions.

The answer is optional provider output, not an authoritative assertion. It must
identify the backend/model when available and cite URLs that also appear in the
normalized result set. Callers can request evidence-only output when they need
to write their own synthesis.

## Backend resolution

Resolution happens before execution and is based on capability and availability,
not only on the active model:

1. an active OpenAI Responses or Codex Responses model uses its native backend;
2. for another active model, an authenticated OpenAI/Codex Responses model in
   Pi's model registry is eligible. This preserves the useful built-in search
   behavior without requiring the user to change models;
3. an active Gemini or xAI Responses model uses its native grounding;
4. explicit `gemini`, `xai`, or `xai-x` hints may resolve a compatible registry
   model through `executionModel` without changing the active model;
5. configured Exa is the automatic direct path for other models;
6. configured Brave is the last direct path when Exa is unavailable and its
   free-mode admission policy allows it;
7. Parallel and exact X search remain explicit capabilities.

Cross-provider native search is an intentional use of credentials already
configured in Pi. The selected execution provider and model are reported in
response metadata. A provider hint is strict: it never silently changes to a
different provider.

The model registry is queried for available model metadata; credentials are
resolved only by the selected adapter at execution time. No environment-wide
credential scan is added.

## Failure policy

Automatic routing may carry at most one alternative backend. A failed primary
may use that one alternative only for failures known to be rejected or
unavailable before a billable result can be produced (authentication, rate
limit, or unavailable), and only for automatic routing. Network, timeout, and
post-dispatch HTTP failures have unknown effects and remain final. Bad
requests, unsupported constraints, malformed data, cancellation, and explicit
provider hints also remain final. The fallback is visible as a warning
with the failed provider and error class. There is no retry loop, fan-out,
provider comparison, or fallback after a successful response.

The default fallback is therefore bounded to two provider calls. It is not a
promise that a metered call is free; direct providers are only eligible when
their credentials and billing policy already admit them. This policy favors a
working result without reproducing the old extension's unbounded auto chain.

## Source depth

Search snippets are often insufficient. `web_search` accepts an explicit,
bounded `includeContent` option. When enabled, it fetches only the first few
selected result URLs through the same local SSRF-safe fetcher used by
`web_fetch`, with per-source length, count, deadline, cancellation, and output
bounds. Fetched pages are returned as untrusted source content with final URL,
extraction, status, and truncation metadata. Failed enrichment is a warning;
the search evidence is retained.

No remote extraction service or browser is inserted into this path.

## Provider adapter contract

Adapters return normalized evidence and may return a typed `SearchAnswer`.
They must preserve source URLs, citation identity, provider/model metadata,
request IDs, usage, rate limits, and warnings. Shared cleanup applies URL
identity, deduplication, hard domain filtering, and field bounds after adapter
normalization. Model-mediated adapters must not read Pi auth state globally.

The OpenAI/Codex adapter extracts the Responses message answer and URL
annotations instead of discarding them. Gemini derives answer citations from
`groundingSupports`; xAI distinguishes all encountered citations from inline
answer annotations. Direct providers remain
evidence-first unless they expose a stable answer contract.

## Verification contract

Offline tests must cover:

- registry-driven cross-provider OpenAI/Codex selection with no active native
  model;
- strict explicit provider selection;
- one bounded fallback with visible diagnostics and no fallback for invalid,
  unsupported, malformed, or canceled calls;
- answer extraction and citation/source alignment;
- optional source enrichment using a fake safe fetcher and output bounds; and
- complete Pi model-registry → router → adapter → tool-output execution.

Credentialed live smoke tests remain deliberate and are not latency benchmarks.
