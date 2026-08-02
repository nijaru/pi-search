# Required workflow inventory

## Scope

This is the revised quality inventory for determining whether `pi-search` can
replace `pi-web-access`. It records user-visible outcomes, not just adapter
presence. A feature is required when losing it makes normal search less useful,
less reliable, or less safe; exact feature parity with the reference package is
not the target.

This is the current-runtime baseline, not the long-term provider ceiling. The
long-term portfolio target, evaluation order, and conditional provider
additions are tracked in `ai/design/provider-consolidation-plan.md` and
`docs/implementation-plan.md`.

## Required in pi-search

| Workflow | Current owner/status | Acceptance evidence |
| --- | --- | --- |
| Task-useful web search | **Implemented; live quality gate open**: typed cited provider answers when available, readable evidence otherwise | A normal question yields a concise, citation-bearing answer or clearly usable evidence for the active model; no raw JSON or unexplained snippets |
| Automatic backend resolution | **Implemented; fresh Pi integration gate open**: active native first, authenticated registry OpenAI/Codex next, Exa, then Brave | Normal search uses an available suitable native/direct backend without unnecessary manual provider selection; cross-provider use and billing are explicit in policy and diagnostics |
| Bounded search resilience | **Implemented**: one visible automatic alternative only for safe authentication/rate-limit/unavailable failures; outcome-unknown failures remain final | A bounded, visible policy handles rejected/unavailable backends without unbounded fan-out, duplicate paid calls, or masking uncertain effects |
| Native OpenAI Responses search | `src/openai.ts`; registry routing, typed answer/citations, fixtures, and one fresh Codex Pi smoke pass | Pi model-registry auth, current Responses fixtures, one deliberate live smoke, usable answer/citations |
| Native OpenAI Codex search | `src/openai.ts`; parser, ChatGPT endpoint, typed citations, and fresh-process smoke pass shipped | Correct ChatGPT endpoint, fresh-process live smoke, usable answer/citations |
| Search for local/non-native models | Exa/Brave/Parallel adapters shipped; workflow quality gap remains | Works with normal active models, returns useful evidence/context, and exposes bounded cost/provenance |
| Gemini grounding | `src/gemini.ts`; shipped | Model-registry auth, explicit `executionModel`, support-linked citations, active model selection; live smoke open |
| xAI web search | `src/xai.ts`; shipped | Model-registry/API/OAuth auth, citation fixtures, explicit model selection; live smoke open |
| Semantic/model-mediated X search | `xai-x`; shipped | Explicit provider, bounded handles/date/media options, citation fixtures; no web-domain promise; live OAuth smoke open |
| Official X recent search | `x`; shipped as explicit provider | Query operators, bounded handle/date options, direct post URLs/text/IDs, rate-limit fixtures; dedicated lookup/archive endpoints remain deferred |
| Evidence normalization and cleanup | `src/search-cleanup.ts`; shipped | URL identity, deduplication, field bounds, hard domain post-filter |
| Source depth and context | **Implemented**: explicit `includeContent` uses the local safe fetcher with bounded count/length/deadline | Optional bounded fetch of selected sources with clean excerpts, preserved URLs, and explicit truncation/provenance |
| Credential, cost, rate-limit, and request provenance | contracts/adapters; in progress | Header-only redaction, success IDs, usage/rate-limit metadata, visible backend diagnostics |
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
| Unbounded provider fan-out | Not required | Risks duplicate paid calls, hidden latency, and ambiguous provenance; any fallback must be bounded and visible |
| Answer synthesis | **Open design decision** | Old/provider-generated answers improve task usefulness, but synthesis must retain citations, identify the backend/model, and avoid treating remote text as instructions |
| Curator UI/storage | Not currently required | Useful in the old extension, but only adopt if an actual workflow needs interactive review or persistence |
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

The current adapter/test inventory is not sufficient for cutover. The quality
contract above must pass before another package switch is considered.

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
