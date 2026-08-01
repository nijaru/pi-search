# pi-search brief

## Current state

`pi-search` is a public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. The current branch and remote are clean at
`18e820c`; the installed package still needs a refresh after the latest fixes.
The public surface is exactly `web_search`, `web_fetch`, and `web_research`.

Shipped search adapters are OpenAI/Codex, Gemini, xAI web and X, Brave, Exa,
and Parallel. Fetching includes pinned DNS/SSRF and redirect checks, streamed
limits, local HTML/Markdown extraction, bounded PDF text, and bounded YouTube
captions. Search results have shared URL cleanup, hard domain enforcement,
provenance preservation, deduplication, and output bounds. The explicit
live-smoke runner exists but no credentialed provider calls have been run.

`pi-web-access` is still installed only as a temporary migration state. The
final direction is one extension: pi-search must cover all required workflows
correctly before the prior runtime is removed.

## Active objective

Make pi-search the sole complete web-search/fetch/research extension for our
actual needs. Do not accept the current implementation as the final cutover
until the audit findings are fixed, prior workflows are inventoried, required
capabilities are implemented, and live provider/Pi integration checks pass.

## Review blockers

- Credentialed provider calls and representative Pi workflows remain unverified.
- The prior package is still installed as a temporary migration aid.

The shared hard-domain boundary, bounded domain inputs, header-only auth
redaction, successful request IDs, token usage, standard rate-limit metadata,
Codex smoke endpoint, and response-level search trust fence are implemented
and tested.

## Verification

Offline verification currently passes: 116 tests, 270 assertions, TypeScript,
`git diff --check`, provider/tool fixtures, and the Codex endpoint assertion.
Live smoke dry-run and fail-closed credential checks pass. Actual provider
calls, representative Pi workflows, installed-package refresh, and the final
single-extension cutover remain unverified.

## Next action

Use `ai/research/required-workflows.md` as the cutover checklist. Refresh the
installed Git package, run credentialed live/Pi acceptance for every required
row, and record any provider-specific skips or failures. Only after those
gates pass should `pi-web-access` be removed from the active runtime.
