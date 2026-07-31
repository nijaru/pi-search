# Provider and replacement policy

This document records the cost and ownership decisions for `pi-search`.
Provider prices, quotas, and model capabilities change; they are not treated
as permanent rankings.

## Ordinary search

The default is **native subscription first, then explicitly enabled Brave**:

1. An active `openai` or `openai-codex` model uses its native Responses
   `web_search` capability.
2. Native failures are final. They never fall back to Brave or a paid service.
3. Other models may use Brave only when `BRAVE_API_KEY` is configured and
   `PI_SEARCH_BRAVE_FREE_ONLY=1` explicitly asserts that the account's free
   capacity covers the call.
4. `PI_SEARCH_ALLOW_METERED=1` explicitly permits configured metered Brave
   calls. It is not set by the extension.
5. If no eligible provider exists, the tool fails clearly. There are no
   automatic retries or cross-provider fallbacks.

The free-capacity flag is a user assertion, not a provider guarantee. Brave's
account headers remain authoritative for known rate windows. A quota failure
is surfaced with reset metadata and never turns into another provider call.

The public search surface is intentionally limited to query, up to 20 results,
`auto`/`keyword`/`fresh` mode, domain include/exclude filters, and strict
`native`/`brave` provider selection. Publication-date bounds, semantic search,
provider answers, social search, and highlight spans are not shipped because
the selected backends cannot enforce them consistently or they are not needed
for the primary workflow.

## Shipped providers

| Provider | Use | Cost and failure policy | Auth |
| --- | --- | --- | --- |
| OpenAI/Codex native | Default for the active OpenAI/Codex model | Uses the active model's subscription or API billing. One request, no fallback or retry. | Pi model registry execution context |
| Brave | Optional keyword/fresh search for non-native models | Requires explicit free-capacity assertion or metered opt-in. Parses rate windows and stops on known exhaustion. | `BRAVE_API_KEY` |

### Intentionally omitted

Exa, Parallel, Gemini, and xAI are not implemented or selected. Their semantic,
multi-hop, grounding, and social capabilities are not necessary for the user's
normal GPT workflow, and their metered/model-mediated calls create cost and
routing complexity. Add one only after a concrete workflow demonstrates that
native search, Brave, direct fetch, or Bash cannot meet it.

## Transient failures

There are zero automatic retries. A retry is another provider call and may be
another charge. Authentication errors, invalid requests, unsupported filters,
malformed responses, extraction failures, and cancellation are never retried.
Network, 408, 425, 429, and 5xx failures remain visible with stable error
codes, provider identity, retryability, request ID, and bounded rate metadata.

## What the extension owns

- **Search:** native OpenAI/Codex and optional Brave evidence normalization.
- **HTML/text fetch:** pinned DNS transport, SSRF and redirect checks, MIME and
  response-size limits, local Readability/Turndown extraction, cancellation,
  timeout, and untrusted-content fencing.
- **PDF URLs:** safe byte fetch, PDF magic validation, bounded local
  `pdftotext`, bounded pages/text, and temporary-file cleanup. No OCR.
- **YouTube URLs:** bounded local `yt-dlp` captions-only extraction with
  `--ignore-config`, `--no-netrc`, `--no-playlist`, no cookies, language
  selection, output bounds, and temporary-file cleanup. Only canonical HTTPS
  YouTube hosts/video IDs are accepted. No media download, frames, or visual
  analysis. Windows reports an unsupported-platform error because the hard
  process-file bound is POSIX specific.
- **Research:** explicit caller-supplied query plans with one selected
  provider, bounded sequential calls/fetches, one deadline, partial results,
  and no hidden synthesis or fan-out.

## What stays outside the extension

| Workflow | Use |
| --- | --- |
| Repository files and local PDFs | `read`, Bash, and `pdftotext` |
| Git history, branches, issues, and PRs | Bash with `git`/`gh` |
| Repository cloning or code search | Explicit Bash/git workflow; never implicit in URL fetch |
| Video downloads, audio, frames, OCR, and visual analysis | Bash with `yt-dlp`/`ffmpeg` or a dedicated vision workflow |
| Browser automation and JS-only pages | Explicit browser workflow; direct fetch reports failure |
| X-specific retrieval | Native OpenAI search where sufficient; no xAI adapter |

## Replacement and cutover

Keep `pi-web-access` installed during rollout. Its search registrations are
disabled in the active config while its specialty tools remain available for
rollback. The active config is `$XDG_CONFIG_HOME/pi/web-search.json` when XDG
is set, otherwise `~/.pi/web-search.json`.

The replacement acceptance matrix is:

1. Exactly `web_search`, `web_fetch`, and `web_research` register.
2. Native search uses the exact active model and model-registry auth.
3. Brave never runs from key presence alone and never causes hidden fallback.
4. Direct HTML/text fetch passes SSRF, redirect, MIME, byte, deadline, and
   cancellation tests.
5. PDF and YouTube caption paths are bounded, local, and cleaned up.
6. Research validates budgets before effects and reports partial completion.
7. Deterministic offline tests pass; live tests are explicit and credential
   gated.
8. Re-enabling `pi-web-access` is the rollback; uninstall only after the
   workflows above are exercised in the user's normal session.

## Direct fetch invariants

```text
validate request
  -> create one caller/deadline signal
  -> resolve and reject non-global addresses
  -> connect using the validated address while retaining host/SNI
  -> follow only manually revalidated redirects
  -> stream and bound response bytes
  -> validate status and MIME
  -> extract locally or return explicitly marked raw HTML
  -> bound output and fence it as untrusted
  -> close body/socket, child process, temporary files, and cancellation hooks
```

One overall deadline covers DNS, connect, redirects, body reads, extraction,
and specialty subprocesses. No phase resets it.
