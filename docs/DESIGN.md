# pi-search design

## Public boundary

The extension exposes exactly three Pi tools:

- `web_search` returns normalized search evidence and provenance.
- `web_fetch` retrieves bounded content from a selected URL.
- `web_research` runs an explicit, budgeted multi-step workflow.

In-content matching is internal. Browser automation, crawling, and remote
extraction services are not part of the extension.

## Provider boundary

The shipped providers are:

- **OpenAI/Codex native Responses search**, selected for the active model and
  authenticated through Pi's model registry.
- **Brave**, optional for keyword/fresh searches when the user explicitly
  asserts free capacity or permits metered use.

The tool boundary supplies `ProviderContext`; adapters must not read Pi's model
registry, credentials, or other runtime state through globals. Native search is
strict: an authentication, rate-limit, or transient failure is visible and
never falls through to another provider. Brave is also strict: a failure never
starts a second provider call.

Exa, Parallel, Gemini, and xAI are intentionally omitted. They add metered
semantic, multi-hop, grounding, or social capabilities that are not required by
the primary OpenAI/Codex workflow. If a future workflow justifies one, add it
as a separate reviewed adapter rather than enabling hidden fallback.

## Search routing

Normal search selects exactly one provider:

1. An active OpenAI/Codex model uses that model's native `web_search`.
2. Other models may use Brave only when `BRAVE_API_KEY` is configured and
   `PI_SEARCH_BRAVE_FREE_ONLY=1` asserts free capacity.
3. `PI_SEARCH_ALLOW_METERED=1` explicitly permits configured metered Brave use.
4. Without an eligible provider, the tool fails clearly; it does not spend
   money to recover.

The public search surface is deliberately small: query, result limit, keyword
or freshness mode, domain include/exclude filters, and strict `native` or
`brave` provider selection. Results are evidence, not provider-synthesized
answers.

## Fetch safety and specialty handling

The fetch operation uses a pinned direct HTTP transport, manual redirect
validation, DNS/IP SSRF checks, streamed response-size limits, one overall
deadline, cancellation, and local extraction. Fetched content is always
untrusted data and is fenced at the Pi tool boundary. Successful results report
the produced format, extraction method, redirect count, bytes read, and
truncation state.

`web_fetch` owns these URL-based specialty paths:

- **PDF:** safe-fetch the bytes, validate the PDF magic header, run local
  `pdftotext` with page/output bounds, and remove the temporary file. Scanned
  and encrypted PDFs fail explicitly; OCR is not implicit.
- **YouTube:** recognize supported video URLs, run `yt-dlp` with
  `--ignore-config`, `--no-netrc`, `--no-playlist`, captions-only flags,
  bounded output, and temporary-file cleanup. Only canonical HTTPS YouTube
  hosts/video IDs are accepted; the original URL is reduced to a canonical
  YouTube URL before the subprocess runs. It returns captions only; frames,
  downloads, and visual analysis remain outside the extension. The bounded
  subprocess path currently requires POSIX process limits; Windows reports a
  clear unsupported-platform error rather than running unbounded.

Local filesystem PDFs, repository operations, Git history, GitHub issues/PRs,
video downloads, frames, and OCR belong to Bash with `read`, `git`, `gh`,
`yt-dlp`, `ffmpeg`, or dedicated workflows. The extension never clones a
repository or reads an arbitrary local path as a side effect of URL fetching.

## Research limits

`web_research` is deterministic rather than an additional model planner. The
calling model supplies the question and optional explicit query list. It:

- selects one provider once for the invocation;
- runs searches sequentially;
- optionally fetches a bounded number of result URLs in result order;
- counts search calls, fetches, and total steps separately;
- uses one overall deadline;
- bounds output and reports partial failures; and
- performs no hidden retries, provider fan-out, answer synthesis, or paid
  fallback.

A cost ceiling is rejected unless the selected provider supplies a reliable
per-call estimate. Native provider-internal search activity cannot provide an
exact dollar guarantee, so the default research path uses no cost promise and
relies on the same native subscription policy as ordinary search.

## Replacement scope

This scope replaces the useful, cost-sensitive portions of `pi-web-access`
without reproducing its hidden provider chains, curator UI, persistent search
storage, browser-cookie Gemini access, remote extraction fallbacks, implicit
GitHub cloning, video analysis, or automatic PDF writes to `~/Downloads`.
