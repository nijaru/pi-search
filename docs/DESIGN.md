# pi-search design

## Ownership and public boundary

Pi's main model owns query planning, source evaluation, follow-up decisions,
and answer synthesis. The extension retrieves evidence; it does not run a
hidden planner or rewrite the main conversation's provider payload.

Two ordinary Pi tools are registered by default:

- `web_search`: bounded source results with explicit text provenance.
- `web_fetch`: bounded extraction of a selected URL.

`web_research` is an optional sequential query-batch convenience, enabled by
`PI_SEARCH_ENABLE_RESEARCH=1`. It has no planning or synthesis loop. No other
public tools are introduced.

Every retrieved text is untrusted. Search results are not proof that the
extension read a page, and a citation is not proof that the cited claim is true.
Provider-generated answers are optional, cited, and labeled separately. The
normal search tool explicitly requests evidence only. It does not promise to
avoid backend-internal synthesis or token charges when a provider requires it.

Usage, arguments, and migration examples live in [README](../README.md).
Routing admission and provider capability decisions live in
[provider-policy](provider-policy.md).

## Module boundaries

| Owner | Responsibility |
| --- | --- |
| `src/index.ts` | Pi registration, configured adapter registry, lazy credentials, resource shutdown |
| `src/settings.ts` | Installation backend/model/fallback preferences and optional batch enablement |
| `src/router.ts` | Pure metadata-based selection, capability and spending admission, execution-context binding |
| `src/search.ts` | Request validation, deadlines/cancellation, one explicitly configured safe fallback |
| Provider adapters | Protocol mapping, auth resolution, transport, provider-specific source/usage interpretation |
| `src/contracts.ts`, `src/search-excerpt.ts`, `src/search-cleanup.ts` | Typed evidence, paired excerpt provenance, normalization/deduplication/citation alignment |
| `src/search-tool.ts`, `src/research-tool.ts` | Tool schemas, bounded model text, compact display, reported tool usage |
| `src/fetcher.ts` and extractor modules | Direct retrieval, extraction, extraction bounds, output paging |
| `src/fetch-snapshots.ts` | Immutable bounded session-instance extraction retention |

One configured adapter registry supplies both dispatch and exposed provider
hints. There is no separate provider-availability switchboard. Native adapter
metadata may be registered without resolving credentials or enumerating models
at startup; a call checks available registry metadata before execution.

## Search execution invariants

- The active chat model does not choose the normal search backend or execution
  model. The router binds model-mediated search to registry services without
  forwarding the active chat descriptor. A configured search model pins the
  primary only; per-call model overrides and fallback execution stay separate.
- An explicit `advanced.provider: "native"` deliberately follows the active
  chat model. This escape hatch is strict and has no fallback.
- Adapters resolve credentials through the supplied Pi model registry. They
  preserve resolved `baseUrl`, headers, and provider environment. Explicit
  authorization values or null deletions win over synthesized bearer headers.
- OpenAI API Responses and ChatGPT/Codex standalone search are separate
  adapters. Subscription access does not imply API credit or known free usage.
- Hard constraints must be supported before dispatch. Automatic selection may
  skip an incompatible backend; an explicitly configured primary or per-call
  provider fails rather than silently changing providers or dropping filters.
- No fallback exists unless named in installation configuration. A fallback
  is checked for request support, model availability, and quota only if needed;
  an unused fallback cannot block the primary or a batch. It can execute
  once after a known-safe primary rejection, never after ambiguous network,
  timeout, post-dispatch, malformed, or billed failures. Per-call provider
  overrides do not fall through. There are no retries or provider fan-out.
- OpenAI streaming requires a terminal completed event, supports LF/CRLF SSE,
  and bounds response bytes. Completion-only or partial responses do not count
  as successful search evidence.

## Evidence identity and rendering

A result retains canonical/source URL, title, optional publication date,
provider/upstream/model identity, query, source ID, score, and usage/request
metadata when supplied. Canonicalization preserves opaque percent encoding.
Text and `excerptKind` travel as one typed unit:

- `provider-excerpt`: provider snippet, highlight, or retrieved text; not a
  locally verified page quote.
- `provider-summary`: a provider-generated per-result summary.
- `provider-text`: text whose extraction-versus-synthesis origin is unspecified.

Adapters assign provenance at the field they actually consume. Shared cleanup
never guesses origin from provider identity. Invalid untrusted excerpt metadata
is omitted with a warning while eligible source URLs are retained. Deduplication
and truncation must preserve the text/kind pairing. Whole-answer text has a
separate `SearchAnswer` contract with citations aligned to retained sources.

Model-visible results are readable, sanitized, and byte-bounded. Structured
details retain normalized evidence; display shortening does not alter model
URLs. Fetched content is separate from provider text and identifies its actual
extraction path, final/original URL, timestamp, bounds, and snapshot when kept.

## Fetch resource lifecycle

General fetching uses direct HTTP with DNS-pinned transport, SSRF/redirect
validation, streamed byte limits, one deadline, and cancellation. HTML
extraction is local. Document conversion runs in a disposable cancellable
subprocess; PDF page limits use `pdftotext`, and YouTube reads captions through
bounded `yt-dlp`. No browser, OCR, crawler, or remote converter is implicit.

X posts/Articles are the reviewed exception: disclosed public FxTwitter reads
are the zero-configuration default; an existing browser login is reused only
after explicit connection consent, in an owned temporary tab. Authenticated
failures never fall back to public extraction. Persistent direct-only policy
wins over tool arguments. Browser controls are target-local, not the direct
transport's DNS-pinned network sandbox. Full limits are in README.

The fetcher extracts once, retains only the existing reachable extraction
range, and slices output afterward. The extension instance owns a memory-only
snapshot store shared by fetch, search enrichment, and optional batch fetching.
IDs bind immutable content to the canonical original requested URL and
normalized extraction controls. Omitted paging controls inherit the retained
values; explicit controls must match. Paging changes only offset and page
length and performs no network/browser/DNS work. Invalid, mismatched, expired, or evicted IDs fail
explicitly rather than silently refetching. Live offsets without an ID remain
available and are labeled as such.

Retention has count/byte limits and non-sliding TTL, with lazy expiration and
no background timers. Oversized results are not retained. Batch finalization
releases unshown pages and removes IDs already evicted by its own fetches. Shutdown closes the
store before draining other resources; late completions cannot repopulate it.
Snapshots are not persisted or reconstructed after session replacement/reload.
X access-mode changes govern new external reads, not retained local evidence.
They do not bypass extraction caps or imply complete upstream X coverage.

## Batch limits and cost semantics

The optional batch selects one provider once, executes caller queries in order,
deduplicates results, and may fetch selected pages. It has no fallback. A
malformed response may leave a partial batch and permit independent remaining
queries; authentication/network and other provider failures end search work.
Completed evidence may still be fetched unless canceled or past its deadline.

Step/search-request/fetch counts, time, and output are bounded separately.
Request counts do not bound hosted-provider internal search actions.
`maxEstimatedCostUsd` is a planning threshold, not a billing cap. It requires a
per-request estimate and stops new work when the reconciled planning total
would exceed it. Failed calls retain unconfirmed reservations. The response's
`estimatedCostUsd` is separate from `usage.costUsd`, which includes only actual
provider reports. Cancellation never proves a dispatched request was unbilled.

## Verification

Offline checks cover model-independent routing, explicit preference/override
precedence, billing admission, strict constraints, bounded safe fallback,
registry-resolved routing/auth, provenance through real adapter normalization,
citation alignment, output bounds, cancellation, batch partial results, and
snapshot identity/expiry/eviction/shutdown. Registration tests exercise the
real index → router → adapter → tool path, including enabled/disabled batches.
Credential-gated live checks remain separate; they verify external contracts,
not provider quality or latency. See [live-smoke](live-smoke.md).
