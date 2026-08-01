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

The prior `pi-web-access` package has been removed from the active Pi package
list. pi-search is now the sole active web extension; deferred specialty
workflows are explicit scope decisions in `ai/research/required-workflows.md`.

## Active objective

Make pi-search the sole complete web-search/fetch/research extension for our
actual needs. Do not accept the current implementation as the final cutover
until the audit findings are fixed, prior workflows are inventoried, required
capabilities are implemented, and live provider/Pi integration checks pass.

## Review blockers

- Dedicated live credentials for Gemini, xAI, Brave, Exa, and Parallel were not
  available, so those provider smoke rows are skipped rather than claimed.
- The final process must restart before an already-running Pi session observes
  the package removal and current registration.

The shared hard-domain boundary, bounded domain inputs, header-only auth
redaction, successful request IDs, token usage, standard rate-limit metadata,
Codex smoke endpoint, response-level search trust fence, installed registration,
and native Codex Pi call are verified.

## Verification

Offline verification passes: 116 tests, 270 assertions, TypeScript,
`git diff --check`, provider/tool fixtures, and the Codex endpoint assertion.
Live smoke dry-run and fail-closed credential checks pass. The installed
package registers exactly three tools, and a fresh Pi Codex call returned
structured evidence. Dedicated non-native provider calls remain skipped for
lack of credentials.

## Next action

Use `ai/research/required-workflows.md` as the ongoing coverage checklist.
Restart Pi to load the sole-owner cutover in an existing process. Add a
provider-specific live smoke only when dedicated credentials are available;
never turn skipped providers into unverified claims.
