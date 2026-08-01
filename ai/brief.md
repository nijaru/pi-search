# pi-search brief

## Current state

`pi-search` is a public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The current branch and remote are clean at
`fa7a60e`. The installed Git package is updated to that commit and registers
exactly `web_search`, `web_fetch`, and `web_research`.

Shipped search adapters are OpenAI/Codex, Gemini, xAI web and X, Brave, Exa,
and Parallel. Fetching includes pinned DNS/SSRF and redirect checks, streamed
limits, local HTML/Markdown extraction, bounded PDF text, and bounded YouTube
captions. Search results have shared URL cleanup, provenance preservation,
deduplication, and output bounds. The explicit live-smoke runner exists but no
credentialed provider calls have been run.

`pi-web-access` is still installed only as a temporary migration state. The
final direction is one extension: pi-search must cover all required workflows
correctly before the prior runtime is removed.

## Active objective

Make pi-search the sole complete web-search/fetch/research extension for our
actual needs. Do not accept the current implementation as the final cutover
until the audit findings are fixed, prior workflows are inventoried, required
capabilities are implemented, and live provider/Pi integration checks pass.

## Review blockers

- Supported hard domain filters are not enforced at the shared result boundary.
- Header-only OpenAI authentication can leave a bearer value available to
  diagnostic redaction paths.
- The live Codex smoke context uses the wrong endpoint.
- Successful request IDs and some usage/rate-limit metadata are dropped.
- Domain-list inputs are not bounded by count or aggregate size.
- Search output needs an explicit untrusted-data fence.

## Verification

Offline verification currently passes: 112 tests, 258 assertions, TypeScript,
`git diff --check`, and Pi tool registration. Live smoke dry-run and fail-closed
credential checks pass. Actual provider calls and the final single-extension
cutover remain unverified.

## Next action

Work the open P1 tasks in order: enforce hard constraints and input bounds,
harden diagnostics and metadata, inventory required feature gaps, then run
credentialed live/Pi acceptance. Only after those gates pass should the old
extension be removed from the active runtime.
