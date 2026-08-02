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
import { httpSource, optionalString, optionalTimestamp, objectValue, postJson, requireApiKey, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

export const PARALLEL_SEARCH_ENDPOINT = "https://api.parallel.ai/v1/search";
export const DEFAULT_PARALLEL_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ParallelAdapterOptions {
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
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "usage-based",
};

export interface ParallelRequestPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

export function buildParallelRequest(request: SearchRequest): ParallelRequestPlan {
	const normalized = validateSearchRequest(request);
	if (normalized.dateRange !== undefined || normalized.social !== undefined) {
		throw createProviderError({ provider: "parallel", kind: "unsupported", message: "Parallel Search does not expose exact date-range or dedicated social/X constraints", retryable: false });
	}
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) {
		throw createProviderError({ provider: "parallel", kind: "unsupported", message: "Parallel Search does not expose domain filters in the stable request contract", retryable: false });
	}
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "fresh") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "Parallel Search can prioritize current sources but this request does not impose a date cutoff" });
	}
	const maxResults = normalized.maxResults ?? 10;
	return {
		body: {
			objective: normalized.query,
			search_queries: [normalized.query],
			mode: normalized.mode === "keyword" ? "basic" : normalized.mode === "fresh" ? "advanced" : "advanced",
			max_chars_total: Math.min(24_000, Math.max(2_000, maxResults * 2_000)),
		},
		appliedOptions: ["maxResults", "mode"],
		warnings,
	};
}

function malformed(message: string): never {
	throw createProviderError({ provider: "parallel", kind: "malformed", message: `Parallel returned a malformed response (${message})`, retryable: false });
}

function normalizeParallelResponse(payload: unknown, request: SearchRequest, metadata: { readonly requestId?: string; readonly rateLimits?: ProviderRateLimitInfo } = {}): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "parallel");
	if (!Array.isArray(root.results)) return malformed("results is not an array");
	const results: SearchResult[] = [];
	let discarded = 0;
	for (const value of root.results) {
		const record = objectValue(value, "results[]", "parallel");
		const parsed = httpSource(record.url, "parallel");
		if (parsed === undefined) {
			discarded += 1;
			continue;
		}
		const excerpts = Array.isArray(record.excerpts)
			? record.excerpts.filter((item): item is string => typeof item === "string").slice(0, 3).join("\n")
			: undefined;
		results.push({
			url: parsed.url,
			title: optionalString(record.title, 500),
			domain: parsed.domain,
			publishedAt: optionalTimestamp(record.publish_date),
			...(excerpts === undefined ? {} : { excerpt: excerpts.slice(0, 4_000) }),
			provider: "parallel",
			searchQuery: normalized.query,
		});
	}
	if (discarded > 0 && results.length === 0) return malformed("results contained no parseable HTTP URLs");
	return {
		query: normalized.query,
		results: results.slice(0, normalized.maxResults ?? 10),
		provider: "parallel",
		appliedOptions: [],
		warnings: discarded > 0 ? [{ code: "partial-results", message: `Parallel discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}` }] : [],
		...(metadata.requestId === undefined ? {} : { requestId: metadata.requestId }),
		...(metadata.rateLimits === undefined ? {} : { usage: { rateLimits: metadata.rateLimits } }),
	};
}

export class ParallelProvider implements Provider {
	readonly id = "parallel" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: ParallelAdapterOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? PARALLEL_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_PARALLEL_RESPONSE_BYTES;
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildParallelRequest(normalized);
		const result = await postJson({
			provider: this.id,
			url: this.endpoint,
			headers: { "x-api-key": requireApiKey(this.id, this.apiKey) },
			body: plan.body,
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const payload = result.payload !== null && typeof result.payload === "object" && !Array.isArray(result.payload) ? result.payload as Record<string, unknown> : undefined;
		const searchId = typeof payload?.search_id === "string" ? payload.search_id : undefined;
		const response = normalizeParallelResponse(result.payload, normalized, { requestId: result.requestId ?? searchId, ...(result.rateLimits === undefined ? {} : { rateLimits: result.rateLimits }) });
		return { ...response, appliedOptions: plan.appliedOptions, warnings: [...plan.warnings, ...response.warnings] };
	}
}

export function createParallelProvider(options: ParallelAdapterOptions): ParallelProvider {
	return new ParallelProvider(options);
}
