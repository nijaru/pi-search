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
import { postJson, requireApiKey, httpSource, objectValue, optionalString, optionalTimestamp, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
export const DEFAULT_EXA_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Current published cost for one standard search returning up to 10 results. */
export const EXA_ESTIMATED_SEARCH_COST_USD = 0.007;

export interface ExaAdapterOptions {
	readonly apiKey?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	keyword: true,
	freshness: true,
	semantic: true,
	excerpts: true,
	domainFilter: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "usage-based",
	estimatedCostUsd: EXA_ESTIMATED_SEARCH_COST_USD,
};

function domainQuery(request: SearchRequest): Record<string, unknown> {
	return {
		...(request.domains?.include === undefined ? {} : { includeDomains: [...request.domains.include] }),
		...(request.domains?.exclude === undefined ? {} : { excludeDomains: [...request.domains.exclude] }),
	};
}

export interface ExaRequestPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

export function buildExaRequest(request: SearchRequest): ExaRequestPlan {
	const normalized = validateSearchRequest(request);
	const warnings: SearchWarning[] = [];
	const appliedOptions: SearchOption[] = ["maxResults", "mode"];
	if (normalized.mode === "keyword") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "Exa's current search API uses automatic retrieval; keyword-only ranking is not guaranteed" });
	}
	if (normalized.mode === "fresh") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "Exa search can return recent sources but this request does not impose a date cutoff" });
	}
	if (normalized.domains?.include !== undefined || normalized.domains?.exclude !== undefined) appliedOptions.push("domains");
	return {
		body: {
			query: normalized.query,
			type: "auto",
			numResults: normalized.maxResults,
			contents: { highlights: true },
			...domainQuery(normalized),
		},
		appliedOptions,
		warnings,
	};
}

function malformed(message: string): never {
	throw createProviderError({ provider: "exa", kind: "malformed", message: `Exa returned a malformed response (${message})`, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerptFromRecord(record: Record<string, unknown>): string | undefined {
	if (Array.isArray(record.highlights)) {
		const highlights = record.highlights
			.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			.slice(0, 3);
		if (highlights.length > 0) return highlights.join("\n").slice(0, 4_000);
	}
	for (const value of [record.text, record.summary]) {
		const excerpt = optionalString(value, 4_000);
		if (excerpt !== undefined) return excerpt;
	}
	return undefined;
}

function costFromResponse(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const total = value.total;
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function normalizeExaResponse(payload: unknown, request: SearchRequest, metadata: { readonly requestId?: string; readonly rateLimits?: ProviderRateLimitInfo }): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "exa");
	if (!Array.isArray(root.results)) return malformed("results is not an array");
	const results: SearchResult[] = [];
	let discarded = 0;
	for (const value of root.results) {
		// A single malformed result should not hide otherwise usable evidence.
		if (!isRecord(value)) {
			discarded += 1;
			continue;
		}
		const parsed = httpSource(value.url, "exa");
		if (parsed === undefined) {
			discarded += 1;
			continue;
		}
		const score = typeof value.score === "number" && Number.isFinite(value.score) ? Math.max(0, Math.min(1, value.score)) : undefined;
		results.push({
			url: parsed.url,
			title: optionalString(value.title, 500),
			domain: parsed.domain,
			publishedAt: optionalTimestamp(value.publishedDate),
			excerpt: excerptFromRecord(value),
			provider: "exa",
			searchQuery: normalized.query,
			sourceId: optionalString(value.id, 500),
			score,
		});
	}
	if (discarded > 0 && results.length === 0) return malformed("results contained no parseable HTTP URLs");
	// Billing metadata is useful but non-essential. Ignore an invalid optional
	// cost object rather than turning a successful search into a hard failure.
	const costUsd = costFromResponse(root.costDollars);
	const bodyRequestId = optionalString(root.requestId, 500);
	const usage = costUsd === undefined && metadata.rateLimits === undefined
		? undefined
		: { ...(costUsd === undefined ? {} : { costUsd }), ...(metadata.rateLimits === undefined ? {} : { rateLimits: metadata.rateLimits }) };
	return {
		query: normalized.query,
		results: results.slice(0, normalized.maxResults ?? 10),
		provider: "exa",
		appliedOptions: [],
		warnings: discarded > 0 ? [{ code: "partial-results", message: `Exa discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}` }] : [],
		...(metadata.requestId === undefined && bodyRequestId === undefined ? {} : { requestId: metadata.requestId ?? bodyRequestId }),
		...(usage === undefined ? {} : { usage }),
	};
}

export class ExaProvider implements Provider {
	readonly id = "exa" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: ExaAdapterOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? EXA_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_EXA_RESPONSE_BYTES;
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildExaRequest(normalized);
		const result = await postJson({
			provider: this.id,
			url: this.endpoint,
			headers: { "x-api-key": requireApiKey(this.id, this.apiKey) },
			body: plan.body,
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeExaResponse(result.payload, normalized, result);
		return { ...response, appliedOptions: plan.appliedOptions, warnings: [...plan.warnings, ...response.warnings] };
	}
}

export function createExaProvider(options: ExaAdapterOptions): ExaProvider {
	return new ExaProvider(options);
}
