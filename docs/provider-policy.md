# Provider and replacement policy

Provider capabilities, prices, quotas, and API schemas change. This document
records current routing and spending policy, not a permanent provider ranking.

## Ordinary search

The extension selects exactly one provider:

1. Active OpenAI Responses and Codex Responses models use native OpenAI search.
2. Active Google Gemini and xAI Responses models use native grounding only
   when `PI_SEARCH_ALLOW_METERED=1` explicitly permits it. `xai-x` is explicit
   for X-specific retrieval.
3. Other/local models use Brave only with `BRAVE_API_KEY` and
   `PI_SEARCH_BRAVE_FREE_ONLY=1`, which is a user assertion that free capacity
   covers the call.
4. `PI_SEARCH_ALLOW_METERED=1` permits configured metered Brave, Exa, and
   Parallel only when Exa or Parallel is explicitly selected by provider hint.
5. If nothing is eligible, search fails clearly.

A provider error never starts a second provider call. There are no hidden
retries, paid fallback chains, or automatic multi-provider searches.

## Shipped providers

| Provider | Role | Billing/routing policy | Auth |
| --- | --- | --- | --- |
| OpenAI/Codex | Native default for compatible active model | One Responses call; no fallback | Pi model registry |
| Gemini | Native Google Search grounding for active Gemini | One grounding call; no fallback | Pi model registry |
| xAI | Native web grounding for active xAI Responses | One Responses call; no fallback | Pi model registry |
| xAI X | Explicit social/X grounding | Explicit `xai-x`; no fallback | Pi model registry |
| Brave | Non-native/local fallback path | Free assertion or explicit metered opt-in; quota guarded | `BRAVE_API_KEY` |
| Exa | Semantic retrieval and highlights | Explicit `exa` plus metered opt-in | `EXA_API_KEY` |
| Parallel | Objective-oriented search and excerpts | Explicit `parallel` plus metered opt-in | `PARALLEL_API_KEY` |

The word “fallback” for Brave means fallback in model *selection* when no
native provider applies. It does not mean fallback after a provider failure.

## Why both native and direct providers exist

Native grounding is appropriate when the active model already owns a search
capability, especially OpenAI/Codex, Gemini, and xAI. It avoids routing a local
or unrelated model through a different model and preserves that provider's
citation semantics.

Brave is the cost-controlled general option for local and other models. Exa
and Parallel are useful specialized, metered choices but are never silently
used. Exa is strongest for semantic retrieval/highlights; Parallel is useful
for objective-oriented research and excerpts. Neither provides a reliable
fixed per-call estimate for a hard research cost ceiling, so a cost ceiling is
rejected before calls to those providers.

## Search constraints

Unsupported hard constraints are rejected or surfaced:

- OpenAI/Codex reject excluded-domain filters.
- Gemini grounding has no hard domain-filter contract.
- xAI web search supports allowed/excluded domains; xAI X search does not.
- Parallel's stable Search API contract does not expose domain filters.
- Exa and Brave apply domain filters and return normalized evidence.

Freshness and keyword modes are retrieval hints for model-mediated or semantic
providers. They produce an explicit warning when the provider cannot guarantee
the requested ranking semantics.

## Transient failures

There are zero automatic retries. Authentication, invalid requests,
unsupported filters, malformed responses, and cancellation are not retried.
Network, 408, 425, 429, and 5xx failures remain visible with stable provider,
status, request ID, retry timing, and retryability fields. A caller may decide
to retry as a new tool call.

## Extension ownership

The extension owns:

- provider-neutral search routing and evidence normalization;
- model-registry authentication boundaries;
- direct provider HTTP, bounded responses, cancellation, and error metadata;
- safe direct HTML/text fetching;
- remote PDF extraction through bounded local `pdftotext`;
- remote YouTube caption extraction through bounded local `yt-dlp`; and
- explicit bounded research orchestration.

It does not own:

- local repository/filesystem operations (`read`, Bash, `git`, `gh`);
- browser automation or JS-only page execution;
- video downloads, frames, OCR, or visual analysis (`yt-dlp`, `ffmpeg`, vision
  workflows); or
- implicit cloning, persistent search storage, or provider answer synthesis.

## Coexistence and cutover

Keep `pi-web-access` installed during rollout. Its duplicate search
registration is disabled in the active Pi configuration while specialty tools
remain available for rollback. The config is `$XDG_CONFIG_HOME/pi/web-search.json`
when XDG is set, otherwise `~/.pi/web-search.json`.

Acceptance gates:

1. OpenAI/Codex fixture and live smoke paths remain green.
2. Each added adapter has deterministic offline request/normalization/error
   tests.
3. No provider hint can silently select a different provider.
4. `bun run check` and `git diff --check` pass.
5. Live calls are credential-gated and run only as an explicit smoke test.
