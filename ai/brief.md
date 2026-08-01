# pi-search brief

## Current state

`pi-search` is a public, unversioned Git Pi package at
https://github.com/nijaru/pi-search. Pi installs it from
`git:github.com/nijaru/pi-search`; the local global install is configured from
that source. `pi-web-access` remains installed for specialty capabilities, with
its duplicate search registration disabled in the active XDG configuration.

The extension registers exactly three tools:

- `web_search`: evidence-first, provider-neutral search;
- `web_fetch`: bounded direct fetching and local extraction; and
- `web_research`: caller-planned, budgeted sequential search and fetches.

Shipped search adapters are OpenAI/Codex, Gemini, xAI web and X, Brave, Exa,
and Parallel. The fetch path includes pinned DNS/SSRF and redirect checks,
streamed limits, local Readability/Turndown extraction, PDF text, and bounded
YouTube captions.

## Active objective

Compare existing Pi web extensions and design the best provider and fetch
coverage for this package without hidden cost, provider fan-out, opaque answer
synthesis, or unnecessary browser infrastructure. Preserve evidence-first
results, explicit provider selection, hard constraint reporting, untrusted
content fencing, bounded resources, and deterministic offline tests.

## Verification

The current checkout has 108 passing tests, 247 assertions, and a passing
TypeScript check. These are fixture and boundary tests; credential-gated live
provider smoke tests remain an operational gap.

## Open questions

- Which providers offer reliable social/X retrieval, and under what API or
  subscription constraints?
- Which additional providers materially improve coverage without duplicating
  existing adapters or violating the billing policy?
- Should JavaScript-rendered pages be an explicit opt-in fetch layer, or remain
  outside the extension in favor of browser workflows?
- What normalization and cleanup should happen to provider results without
  turning source evidence into synthesized claims?
