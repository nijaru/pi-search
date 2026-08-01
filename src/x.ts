import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderProfile,
	ProviderRateLimitInfo,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchWarning,
} from "./contracts";
import { createProviderError } from "./errors";
import { getJson, objectValue, optionalString, optionalTimestamp, requireApiKey, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

export const X_RECENT_SEARCH_ENDPOINT = "https://api.x.com/2/tweets/search/recent";
export const DEFAULT_X_RESPONSE_BYTES = 4 * 1024 * 1024;
export const X_MAX_RESULTS = 20;
export const X_MIN_REQUEST_RESULTS = 10;

export interface XAdapterOptions {
	readonly bearerToken?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	keyword: true,
	freshness: true,
	excerpts: true,
	social: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "usage-based",
};

export interface XRequestPlan {
	readonly url: string;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

function malformed(message: string): never {
	throw createProviderError({ provider: "x", kind: "malformed", message: `X API returned a malformed response (${message})`, retryable: false });
}

function postUrl(id: string): string {
	return `https://x.com/i/web/status/${encodeURIComponent(id)}`;
}

function buildQuery(request: SearchRequest): string {
	return request.query;
}

/** Build one bounded recent-search request. Pagination is intentionally explicit and absent. */
export function buildXRequest(request: SearchRequest, endpoint = X_RECENT_SEARCH_ENDPOINT): XRequestPlan {
	const normalized = validateSearchRequest(request);
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) {
		throw createProviderError({ provider: "x", kind: "unsupported", message: "X API post search does not provide web-domain filters", retryable: false });
	}
	const params = new URLSearchParams({
		query: buildQuery(normalized),
		// X requires at least 10 for recent search; the normalized boundary
		// slices the response back to the caller's requested maxResults.
		max_results: String(Math.max(X_MIN_REQUEST_RESULTS, Math.min(normalized.maxResults ?? 10, X_MAX_RESULTS))),
		tweet_fields: "created_at,author_id,public_metrics",
		expansions: "author_id",
		user_fields: "username,name",
	});
	const appliedOptions: SearchOption[] = ["maxResults", "mode"];
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "fresh") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "X recent search is time-bounded by the endpoint; exact freshness ranking is not guaranteed" });
	}
	return { url: `${endpoint}?${params.toString()}`, appliedOptions, warnings };
}

function normalizeXResponse(payload: unknown, request: SearchRequest, metadata: { readonly requestId?: string; readonly rateLimits?: ProviderRateLimitInfo }): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "x");
	if (root.data !== undefined && !Array.isArray(root.data)) return malformed("data is not an array");
	const users = new Map<string, string>();
	if (root.includes !== undefined) {
		const includes = objectValue(root.includes, "includes", "x");
		if (includes.users !== undefined) {
			if (!Array.isArray(includes.users)) return malformed("includes.users is not an array");
			for (const value of includes.users) {
				if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
				const user = value as Record<string, unknown>;
				const id = optionalString(user.id, 100);
				const username = optionalString(user.username, 100);
				if (id !== undefined && username !== undefined) users.set(id, username);
			}
		}
	}
	const results: SearchResult[] = [];
	for (const value of (root.data as unknown[] | undefined) ?? []) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const post = value as Record<string, unknown>;
		const id = optionalString(post.id, 100);
		if (id === undefined) continue;
		const text = optionalString(post.text, 4_000);
		const publishedAt = optionalTimestamp(post.created_at);
		const authorId = optionalString(post.author_id, 100);
		const username = authorId === undefined ? undefined : users.get(authorId);
		results.push({
			url: postUrl(id),
			...(username === undefined ? {} : { title: `@${username}` }),
			domain: "x.com",
			...(publishedAt === undefined ? {} : { publishedAt }),
			...(text === undefined ? {} : { excerpt: text }),
			provider: "x",
			searchQuery: normalized.query,
			sourceId: id,
		});
	}
	if (results.length === 0 && root.data !== undefined && root.data.length > 0) return malformed("data contained no usable posts");
	const usage = {
		...(results.length === 0 ? {} : { billedUnits: results.length, billedUnit: "posts" }),
		...(metadata.rateLimits === undefined ? {} : { rateLimits: metadata.rateLimits }),
	};
	return {
		query: normalized.query,
		results: results.slice(0, normalized.maxResults),
		provider: "x",
		appliedOptions: [],
		warnings: [],
		...(metadata.requestId === undefined ? {} : { requestId: metadata.requestId }),
		...(Object.keys(usage).length === 0 ? {} : { usage }),
	};
}

export class XProvider implements Provider {
	readonly id = "x" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly bearerToken?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: XAdapterOptions) {
		this.bearerToken = options.bearerToken;
		this.endpoint = options.endpoint ?? X_RECENT_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_X_RESPONSE_BYTES;
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildXRequest(normalized, this.endpoint);
		const result = await getJson({
			provider: this.id,
			url: plan.url,
			headers: { authorization: `Bearer ${requireApiKey(this.id, this.bearerToken)}` },
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeXResponse(result.payload, normalized, result);
		return { ...response, appliedOptions: plan.appliedOptions, warnings: [...plan.warnings, ...response.warnings] };
	}
}

export function createXProvider(options: XAdapterOptions): XProvider {
	return new XProvider(options);
}
