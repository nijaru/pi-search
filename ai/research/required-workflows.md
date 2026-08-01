# Required workflow inventory

## Scope

This is the cutover inventory for replacing `pi-web-access` with `pi-search`.
It records the workflows the project has actually called for, rather than
requiring feature parity with every provider and UI in the reference package.
A feature is required only when losing it would break an intended workflow.

## Required in pi-search

| Workflow | Current owner/status | Acceptance evidence |
| --- | --- | --- |
| Native OpenAI Responses search | `src/openai.ts`; shipped | Pi model-registry auth, SSE fixtures, live smoke |
| Native OpenAI Codex search | `src/openai.ts`; shipped | Correct ChatGPT endpoint, fresh-process live smoke |
| Search for local/non-native models | Brave plus explicit Exa/Parallel; shipped | Offline adapters, billing-policy tests, live smoke where credentials exist |
| Gemini grounding | `src/gemini.ts`; shipped | Model-registry auth and grounding fixtures; metered opt-in |
| xAI web search | `src/xai.ts`; shipped | Model-registry auth and citation fixtures; metered opt-in |
| Dedicated X search | `xai-x`; shipped | Explicit provider and citation fixtures; no web-domain promise |
| Evidence normalization and cleanup | `src/search-cleanup.ts`; shipped | URL identity, deduplication, field bounds, hard domain post-filter |
| Credential, cost, rate-limit, and request provenance | contracts/adapters; in progress | Header-only redaction, success IDs, usage/rate-limit metadata, live diagnostics |
| Individual HTML/Markdown/text/JSON page fetch | direct pinned transport and local extraction; shipped | SSRF, redirect, byte, timeout, cancellation, extraction fixtures |
| PDF text extraction | bounded local `pdftotext`; shipped | Fixture and cleanup/cancellation tests; explicit failure for scanned/encrypted PDFs |
| YouTube transcript/caption fetch | bounded local `yt-dlp`; shipped | URL validation, cue cleanup, cancellation tests |
| Explicit bounded multi-query research | `web_research`; shipped | One provider, caller queries, fetch bounds, deadline/cost/output tests |

## Not required for sole cutover

These are useful features in `pi-web-access`, but there is no recorded
requirement or observed workflow that justifies making them part of this
extension's runtime contract now:

| Feature | Correct owner or decision | Reason |
| --- | --- | --- |
| Provider fan-out and automatic fallback | Retired from this contract | Risks duplicate paid calls, hidden latency, and ambiguous provenance |
| Opaque answer synthesis and curator UI | Retired from this contract | Calling model should inspect evidence; Pi UI is not a search-provider contract |
| Search history storage and `get_search_content` | Use repeated bounded `web_fetch`/offsets | Avoids persistent sensitive history; fetch already supports paging |
| GitHub cloning and local repository browsing | Pi `read`, Bash, `git`, and `gh` | Repository operations need filesystem and Git semantics, not web search |
| Local video analysis, frame extraction, and OCR | `yt-dlp`, `ffmpeg`, and a dedicated vision workflow | Media download/vision requires a separate resource and privacy boundary |
| Visual YouTube understanding | Deferred | Captions satisfy the named transcript workflow; no visual-analysis requirement is recorded |
| Browser automation and JavaScript rendering | Deferred, explicit future adapter only | Direct local extraction is safer and cheaper; browser/remote fetch needs SSRF, privacy, and resource review |
| Firecrawl/Jina/TinyFish remote extraction | Deferred | Remote services change privacy, cost, and SSRF ownership; no concrete required page class yet |
| Persistent caching | Deferred | No measured repeated-fetch requirement; caching needs TTL, size, invalidation, and freshness policy |
| `source_check` claim-audit tool | Deferred | Useful but outside the three-tool public contract; research already preserves source evidence |
| Arbitrary extra search providers | Deferred unless a coverage gap appears | Tavily, SearXNG, Perplexity, Anthropic, and similar options overlap shipped capabilities or need a concrete auth/cost requirement |

## Required closure before cutover

The required rows above are not all release-verified yet. Before removing the
old package from the active runtime:

1. Fix the remaining contract audit items: hard constraints, auth diagnostic
   redaction, successful request IDs, bounded provider metadata, and the
   Codex smoke endpoint.
2. Add the search output trust fence and verify the direct installed package
   registers only `web_search`, `web_fetch`, and `web_research`.
3. Run deterministic checks plus one explicit live smoke per available
   provider; record skipped providers without inventing credentials.
4. Exercise representative Pi calls for native search, local-model search,
   X search, page fetch, PDF, YouTube captions, and bounded research.
5. Remove `pi-web-access` from the active package list only after the required
   rows pass. Its extra tools are intentionally not a hidden second runtime.

## Open questions

- Do real workflows require JavaScript-only pages or visual video analysis?
- Is exact date/path filtering needed enough to justify Perplexity or another
  adapter beyond the current provider set?
- Does Pi already provide a preferred page-fetch or media workflow that should
  own any deferred row?
