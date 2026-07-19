/**
 * Provider-neutral contracts for pi-search.
 *
 * These types are the foundation of the extension. They are intentionally
 * agnostic of how a provider fulfills a request — whether by a direct HTTP
 * search endpoint (Exa, Brave, Parallel) or by a model-mediated grounding
 * call (xAI `x_search`, Gemini grounding, OpenAI `web_search`, Claude
 * `WebSearch`). See handoff.md D10 (two adapter families).
 *
 * Nothing here performs I/O or depends on Pi runtime APIs, so it can be
 * unit-tested deterministically and offline. Adapters (the `Provider`
 * implementations) are added later; do not add them before these contracts
 * are stable.
 */

// ─── Common ────────────────────────────────────────────────────────────────

/**
 * A normalized, canonical URL string (already resolved against redirects,
 * with fragment and tracking-noise stripped where a provider exposes it).
 * The original URL the user/agent supplied is preserved separately as
 * `source_url` when it differs.
 */
export type Url = string;

/**
 * ISO-8601 timestamp string when a result was published, fetched, or
 * indexed. Omitted when the provider does not surface one.
 */
export type IsoTimestamp = string;

/**
 * Opaque identifier a provider returns for a single search call, useful for
 * debugging, cost attribution, and provider-side replay. Optional.
 */
export type RequestId = string;

/**
 * Free-form capability flags describing what a provider can do. The router
 * (a later stage, not in this module) uses these to select a provider by
 * task rather than by a fixed vendor ranking (D3).
 */
export interface ProviderCapabilities {
	/** Semantic / neural similarity search (e.g. Exa). */
	readonly semantic?: boolean;
	/** Classic keyword / exact-match retrieval (e.g. Brave). */
	readonly keyword?: boolean;
	/** Freshness-sensitive: index updated frequently, exposes published dates. */
	readonly freshness?: boolean;
	/** Returns source excerpts or highlights alongside the URL. */
	readonly excerpts?: boolean;
	/** Returns a structured answer/excerpt for the page contents (Readability-like). */
	readonly extraction?: boolean;
	/** Covers social/X/Twitter content (e.g. xAI `x_search`). */
	readonly social?: boolean;
	/** Resolves multi-topic / multi-hop queries in a single call (e.g. Parallel). */
	readonly multiHop?: boolean;
	/** Provider can produce a synthesized answer (opt-in; non-default per D2). */
	readonly answerSynthesis?: boolean;
	/** Supports domain include/exclude filters. */
	readonly domainFilter?: boolean;
	/** Supports date-range filtering (from/to). */
	readonly dateFilter?: boolean;
}

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * How results should be ranked/retrieved. Mirrors the capability axes so the
 * router can pick a provider whose capabilities match the requested mode.
 */
export const SearchMode = {
	/** Semantic similarity; find conceptually related content. */
	semantic: "semantic",
	/** Exact / keyword matching. */
	keyword: "keyword",
	/** Freshness-first; newest relevant results. */
	fresh: "fresh",
	/** Multi-hop / multi-topic research resolution. */
	multiHop: "multiHop",
	/** Social/X/Twitter content. */
	social: "social",
	/** Provider-native default (no explicit bias). */
	auto: "auto",
} as const;
export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode];

/**
 * Domain filter: restrict or exclude specific hosts.
 *
 * Empty by default. An entry in `include` restricts results to those hosts;
 * an entry in `exclude` removes them. A host should not appear in both.
 */
export interface DomainFilter {
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
}

/**
 * Provider-neutral search request. Every field is optional except `query`
 * so that a caller can start with a bare string and refine as needed.
 *
 * Adapters map this to their provider-specific payload; unknown/unsupported
 * options are silently ignored (a provider that can't filter by date should
 * not reject a request that happens to ask for one — it should just return
 * its best results).
 */
export interface SearchRequest {
	/** Natural-language or keyword query. Required. */
	readonly query: string;
	/** Retrieval bias; default `auto`. */
	readonly mode?: SearchMode;
	/** Maximum results to return. Adapters may return fewer. */
	readonly maxResults?: number;
	/** Restrict/exclude hosts. */
	readonly domains?: DomainFilter;
	/** Only results published after this ISO-8601 timestamp (inclusive). */
	readonly publishedAfter?: IsoTimestamp;
	/** Only results published before this ISO-8601 timestamp (inclusive). */
	readonly publishedBefore?: IsoTimestamp;
	/**
	 * Hint to prefer a specific provider by id. The router may still override
	 * when the provider lacks the requested capability. Normal callers should
	 * omit this and let the router choose (D3).
	 */
	readonly providerHint?: ProviderId;
	/**
	 * Opt into a provider-synthesized answer. Disabled by default per D2:
	 * the default path returns inspectable evidence, not opaque summaries.
	 * When enabled, the chosen provider may populate `SearchResponse.answer`.
	 */
	readonly wantAnswer?: boolean;
	/**
	 * Opt into raw highlight spans (offset snippets) when the provider
	 * supports them. Off by default; excerpts are returned regardless.
	 */
	readonly wantHighlights?: boolean;
}

/**
 * A single normalized search result. This is the evidence-first unit per D2:
 * the agent inspects and cites these rather than trusting an opaque summary.
 */
export interface SearchResult {
	/** Result URL (canonical where available). */
	readonly url: Url;
	/** Original URL as supplied, when it differs from the canonical `url`. */
	readonly sourceUrl?: Url;
	/** Page title. */
	readonly title?: string;
	/** Publishing host / domain. */
	readonly domain?: string;
	/** When the page was published, if known. */
	readonly publishedAt?: IsoTimestamp;
	/**
	 * Short text excerpt/snippet describing or from the page. Always returned
	 * when the provider exposes any text; never synthesized.
	 */
	readonly excerpt?: string;
	/**
	 * Provider-highlighted spans within the excerpt (offset ranges or marked-up
	 * text). Only when `wantHighlights` is set and the provider supports it.
	 */
	readonly highlights?: readonly string[];
	/** The provider that produced this result. */
	readonly provider: ProviderId;
	/** The query that produced this result. */
	readonly searchQuery: string;
	/** Provider-internal id for the result, for citation/debugging. */
	readonly sourceId?: string;
	/**
	 * Provider-reported relevance, normalized to [0,1] where available.
	 * Not comparable across providers.
	 */
	readonly score?: number;
}

/**
 * Provider-neutral search response.
 */
export interface SearchResponse {
	/** The query that was executed (after any normalization). */
	readonly query: string;
	/** Results, best-first. May be empty. */
	readonly results: readonly SearchResult[];
	/**
	 * Provider-synthesized answer. Only present when the request had
	 * `wantAnswer: true` and the provider supports it (D2 non-default path).
	 */
	readonly answer?: string;
	/** Which provider actually served the request. */
	readonly provider: ProviderId;
	/** Provider request id for debugging/attribution. */
	readonly requestId?: RequestId;
	/** Wall-clock latency in milliseconds. */
	readonly latencyMs?: number;
}

// ─── Fetch ─────────────────────────────────────────────────────────────────

/**
 * Provider-neutral fetch request for a known URL.
 *
 * Only user-supplied or search-returned URLs may be fetched by default (D6).
 * The fetcher revalidates redirects, blocks private/link-local/metadata
 * addresses, caps response size, and fences extracted text as untrusted.
 */
export interface FetchRequest {
	/** URL to fetch. Must be http(s). */
	readonly url: Url;
	/** Hard cap on extracted text length, in characters. */
	readonly maxLength?: number;
	/** Format hint; fetcher may still pick based on content-type. */
	readonly format?: "markdown" | "text" | "html";
	/** Strip the page to its main readable content (Readability). Default true. */
	readonly readable?: boolean;
}

/**
 * Fetched page content. The extracted text is treated as untrusted content:
 * callers must not execute or parse it as instructions (D6).
 */
export interface FetchedContent {
	/** Final URL after redirects. */
	readonly url: Url;
	/** Original URL requested, when it differs from the final `url`. */
	readonly sourceUrl?: Url;
	/** Page title. */
	readonly title?: string;
	/** Extracted text/markdown/html body. */
	readonly content: string;
	/** Content type as served. */
	readonly contentType?: string;
	/** When the content was fetched. */
	readonly fetchedAt: IsoTimestamp;
	/** Final HTTP status. */
	readonly status: number;
	/** True if the readable-content extractor fell back to raw HTML. */
	readonly fellBackToRaw?: boolean;
}

// ─── Find (in-content) ─────────────────────────────────────────────────────

/**
 * A located passage within already-fetched content. `web_find` uses this to
 * let the agent locate exact text without re-fetching (D4).
 */
export interface FindResult {
	/** The search term or pattern that was located. */
	readonly query: string;
	/** Zero-based character offset of the match within the fetched content. */
	readonly offset: number;
	/** Length of the matched span in characters. */
	readonly length: number;
	/** Surrounding context window around the match. */
	readonly excerpt: string;
}

// ─── Provider interface ────────────────────────────────────────────────────

/**
 * Identifier for a provider. Used in results and capability descriptors.
 * The concrete union grows as adapters land; string allows forward-compat.
 */
export type ProviderId =
	| "exa"
	| "brave"
	| "parallel"
	| "gemini"
	| "xai"
	| (string & {});

/**
 * A normalized error from a provider call. Carries enough to route retries
 * or report to the agent without leaking provider-specific payload shapes.
 */
export interface ProviderError extends Error {
	readonly provider: ProviderId;
	/** Network failure, auth failure, rate limit, bad request, etc. */
	readonly kind: "network" | "auth" | "rateLimit" | "badRequest" | "http" | "unknown";
	/** HTTP status if applicable. */
	readonly status?: number;
	/** Whether retrying the same provider could help. */
	readonly retryable: boolean;
}

/**
 * The provider-neutral adapter contract. Both adapter families (D10) implement
 * this: a direct search API maps the request to an HTTP call and parses the
 * response; a model-mediated grounding provider maps it to a grounded model
 * call. The contract is identical to the caller.
 *
 * `fetch` is optional because not every search provider also fetches pages;
 * direct HTTP fetch is handled separately in the `web_fetch` tool.
 */
export interface Provider {
	readonly id: ProviderId;
	readonly capabilities: ProviderCapabilities;
	/**
	 * Execute a search. Adapters must:
	 * - ignore unsupported request options rather than throwing;
	 * - normalize results to {@link SearchResult};
	 * - preserve `url`, `excerpt`, `publishedAt`, `provider`, `searchQuery`;
	 * - never synthesize an answer unless `request.wantAnswer` is set.
	 */
	readonly search: (request: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>;
	/**
	 * Optional page fetch. Most search providers do not implement this;
	 * `web_fetch` uses a dedicated HTTP fetcher instead.
	 */
	readonly fetch?: (request: FetchRequest, signal: AbortSignal) => Promise<FetchedContent>;
}

/**
 * Narrow helper: does this provider claim a given capability?
 */
export function hasCapability(provider: Provider, cap: keyof ProviderCapabilities): boolean {
	return Boolean(provider.capabilities[cap]);
}
