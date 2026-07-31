/**
 * Provider-neutral contracts for pi-search.
 *
 * These types are the foundation of the extension. They are intentionally
 * agnostic of how a provider fulfills a request — whether by a direct HTTP
 * search endpoint (Exa, Brave, Parallel) or by a model-mediated grounding
 * call (xAI `x_search`, Gemini grounding, OpenAI `web_search`, Claude
 * `WebSearch`). See `docs/DESIGN.md` for the two adapter families.
 *
 * Nothing here performs I/O or depends on Pi runtime APIs, so it can be
 * unit-tested deterministically and offline. Provider adapters build on these
 * contracts and keep their transport and payload handling in separate modules.
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
 * The narrow model-auth surface needed by model-mediated providers. Keeping
 * this structural avoids coupling the contracts to Pi's runtime types while
 * still making the auth boundary explicit at the tool adapter.
 */
export interface ProviderModelRegistry {
	readonly getApiKeyAndHeaders: (model: string) => Promise<{
		readonly apiKey?: string;
		readonly headers?: Readonly<Record<string, string>>;
	}>;
}

/**
 * Runtime services supplied by the Pi tool boundary to a provider adapter.
 * Direct HTTP providers may ignore this context; model-mediated providers
 * must use `modelRegistry` rather than reading Pi credentials globally.
 */
export interface ProviderContext {
	readonly model?: string;
	readonly modelRegistry?: ProviderModelRegistry;
}

/**
 * Operational information used by the router for bounded provider selection.
 * Estimates are advisory; actual usage belongs in `SearchResponse.usage`.
 */
export interface ProviderProfile {
	readonly typicalLatencyMs?: number;
	readonly estimatedCostUsd?: number;
	readonly costModel: "free" | "per-request" | "usage-based" | "unknown";
	readonly auth: "none" | "environment" | "modelRegistry";
}

/**
 * Provider-reported billing information when available.
 */
export interface ProviderUsage {
	readonly costUsd?: number;
	readonly billedUnits?: number;
	readonly billedUnit?: string;
}

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
 * Adapters map this to their provider-specific payload. Unsupported options
 * must be surfaced in `SearchResponse.warnings`; hard constraints must never
 * disappear silently.
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

/** Options whose handling must be visible in the normalized response. */
export type SearchOption =
	| "mode"
	| "maxResults"
	| "domains"
	| "publishedAfter"
	| "publishedBefore"
	| "wantAnswer"
	| "wantHighlights";

/** A non-fatal limitation or partial-application notice. */
export interface SearchWarning {
	readonly code: "unsupported-option" | "partial-results";
	readonly option?: SearchOption;
	readonly message: string;
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
	/** Options the provider applied, including post-filtered constraints. */
	readonly appliedOptions: readonly SearchOption[];
	/** Explicit warnings for options that were unsupported or only partial. */
	readonly warnings: readonly SearchWarning[];
	/** Provider request id for debugging/attribution. */
	readonly requestId?: RequestId;
	/** Wall-clock latency in milliseconds. */
	readonly latencyMs?: number;
	/** Provider-reported billing information, when available. */
	readonly usage?: ProviderUsage;
}

// ─── Research ──────────────────────────────────────────────────────────────

/**
 * Required limits for the multi-step research tool. The orchestrator must
 * reject invalid budgets before making a provider call and stop at every
 * limit, including the cost limit when usage is reported.
 */
export interface ResearchBudget {
	readonly maxSteps: number;
	readonly maxProviderCalls: number;
	readonly timeoutMs: number;
	readonly maxCostUsd?: number;
}

export interface ResearchRequest {
	readonly query: string;
	readonly budget: ResearchBudget;
	/** Optional provider preferences; cross-provider use remains explicit. */
	readonly providerHints?: readonly ProviderId[];
}

export interface ResearchResponse {
	readonly query: string;
	readonly results: readonly SearchResult[];
	readonly stepsCompleted: number;
	readonly providerCalls: number;
	readonly usage?: ProviderUsage;
	readonly warnings: readonly SearchWarning[];
}

/** Validate the hard limits before the research orchestrator starts. */
export function validateResearchBudget(budget: ResearchBudget): void {
	if (!Number.isInteger(budget.maxSteps) || budget.maxSteps < 1) {
		throw new Error("Research budget maxSteps must be a positive integer");
	}
	if (!Number.isInteger(budget.maxProviderCalls) || budget.maxProviderCalls < 1) {
		throw new Error("Research budget maxProviderCalls must be a positive integer");
	}
	if (!Number.isFinite(budget.timeoutMs) || budget.timeoutMs <= 0) {
		throw new Error("Research budget timeoutMs must be positive");
	}
	if (budget.maxCostUsd !== undefined && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)) {
		throw new Error("Research budget maxCostUsd must be non-negative");
	}
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
	/** Start offset into the produced content, in characters. */
	readonly offset?: number;
	/** Format hint; the response reports the produced format explicitly. */
	readonly format?: "markdown" | "text" | "html";
	/** Strip the page to its main readable content (Readability). Default true. */
	readonly readable?: boolean;
	/** Permit bounded raw HTML when readable extraction fails. Default true. */
	readonly allowRawHtmlFallback?: boolean;
}

export type FetchOutputFormat = "markdown" | "text" | "html";
export type FetchExtraction = "readability" | "raw" | "plain-text";

export interface FetchWarning {
	readonly code: "truncated" | "raw-fallback";
	readonly message: string;
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
	/** Fetched content is data, never executable or trusted instructions. */
	readonly contentTrust: "untrusted";
	/** Content type as served. */
	readonly contentType?: string;
	/** Format actually returned, rather than only the requested hint. */
	readonly outputFormat: FetchOutputFormat;
	/** Extraction path used to produce `content`. */
	readonly extraction: FetchExtraction;
	/** When the content was fetched. */
	readonly fetchedAt: IsoTimestamp;
	/** Final HTTP status. */
	readonly status: number;
	/** Number of manually followed redirects. */
	readonly redirectCount: number;
	/** Body bytes consumed before decoding. */
	readonly bytesRead: number;
	/** Whether output was bounded to `maxLength`. */
	readonly truncated: boolean;
	/** Character offset used for this result. */
	readonly offset: number;
	/** Next offset when more produced content remains. */
	readonly nextOffset?: number;
	/** Total produced characters when known locally. */
	readonly totalCharacters?: number;
	/** Explicit extraction/truncation notices. */
	readonly warnings: readonly FetchWarning[];
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
	readonly kind:
		| "network"
		| "auth"
		| "rateLimit"
		| "badRequest"
		| "malformed"
		| "unsupported"
		| "timeout"
		| "canceled"
		| "http"
		| "unknown";
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
	readonly profile: ProviderProfile;
	/**
	 * Execute a search. Adapters must:
	 * - apply supported options and list them in `appliedOptions`;
	 * - report unsupported options in `warnings` or throw `ProviderError` with
	 *   kind `unsupported`;
	 * - normalize results to {@link SearchResult};
	 * - preserve `url`, `excerpt`, `publishedAt`, `provider`, `searchQuery`;
	 * - never synthesize an answer unless `request.wantAnswer` is set.
	 */
	readonly search: (
		request: SearchRequest,
		signal: AbortSignal,
		context: ProviderContext,
	) => Promise<SearchResponse>;
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
