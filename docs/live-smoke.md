# Live provider smoke tests

`bun run check` is always offline. Live smoke tests are a separate, explicit
operation and make one request to exactly one selected provider.

## Safety gates

Set all of these for a real call:

```bash
export PI_SEARCH_LIVE=1
export PI_SEARCH_LIVE_ALLOW_METERED=1
export PI_SEARCH_LIVE_PROVIDER=brave
export PI_SEARCH_LIVE_BRAVE_API_KEY=...
bun run live:smoke
```

The runner does not infer a provider from credentials. It performs no retries,
fallbacks, pagination, or fan-out. It prints only bounded source metadata,
warning codes, request IDs, and usage. Credentials must be supplied through
the provider-specific `PI_SEARCH_LIVE_*` variables; never put them on the
command line.

Use `--provider=<id>` instead of `PI_SEARCH_LIVE_PROVIDER` when preferred. The
supported IDs are `openai`, `openai-codex`, `gemini`, `xai`, `xai-x`, `x`,
`brave`, `exa`, and `parallel`.

## Credentials

| Provider | Required variables |
| --- | --- |
| `openai` | `PI_SEARCH_LIVE_OPENAI_API_KEY`, `PI_SEARCH_LIVE_OPENAI_MODEL` |
| `openai-codex` | `PI_SEARCH_LIVE_CODEX_TOKEN`, `PI_SEARCH_LIVE_CODEX_MODEL` |
| `gemini` | `PI_SEARCH_LIVE_GEMINI_API_KEY`, `PI_SEARCH_LIVE_GEMINI_MODEL` |
| `xai`, `xai-x` | `PI_SEARCH_LIVE_XAI_API_KEY`, `PI_SEARCH_LIVE_XAI_MODEL` |
| `x` | `PI_SEARCH_LIVE_X_API_BEARER_TOKEN` |
| `brave` | `PI_SEARCH_LIVE_BRAVE_API_KEY` |
| `exa` | `PI_SEARCH_LIVE_EXA_API_KEY` |
| `parallel` | `PI_SEARCH_LIVE_PARALLEL_API_KEY` |

Codex smoke calls use the ChatGPT backend's standalone `alpha/search`
endpoint (`https://chatgpt.com/backend-api/codex/alpha/search`), not the public
OpenAI API Responses endpoint. Use a token accepted by that backend; when it is
an OAuth JWT, the adapter forwards its ChatGPT account id when present.

Use a dedicated smoke key or token. The acknowledgement flag is required
because these calls may consume quota or incur charges, including native
model-mediated search.

## Dry run

Check the opt-in and credential presence without making a network request:

```bash
PI_SEARCH_LIVE=1 PI_SEARCH_LIVE_PROVIDER=brave bun run live:smoke --dry-run
```

The dry run prints booleans only; it never prints credential values.

## Checks performed

A successful call must return at least one bounded HTTP(S) source URL, the
selected provider ID, the requested query, and no embedded URL credentials.
The runner also checks normalized domains and enforces the `iana.org` include
filter for providers whose adapters declare domain support. Exact titles and
URLs are intentionally not asserted because live search rankings change.

Provider failures, rate limits, missing credentials, and timeouts are terminal
for that invocation. Run a new explicit command if a retry is desired.
