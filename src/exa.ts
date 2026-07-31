import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderProfile,
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

function normalizeExaResponse(payload: unknown, request: SearchRequest, metadata: { readonly requestId?: string }): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "exa");
	if (!Array.isArray(root.results)) return malformed("results is not an array");
	const results: SearchResult[] = [];
	let discarded = 0;
	for (const value of root.results) {
		const record = objectValue(value, "results[]", "exa");
		const parsed = httpSource(record.url, "exa");
		if (parsed === undefined) {
			discarded += 1;
			continue;
		}
		const highlights = Array.isArray(record.highlights)
			? record.highlights.filter((item): item is string => typeof item === "string").slice(0, 3).join("\n")
			: undefined;
		const excerpt = highlights ?? optionalString(record.text ?? record.summary, 4_000);
		const score = typeof record.score === "number" && Number.isFinite(record.score) ? Math.max(0, Math.min(1, record.score)) : undefined;
		results.push({
			url: parsed.url,
			title: optionalString(record.title, 500),
			domain: parsed.domain,
			publishedAt: optionalTimestamp(record.publishedDate),
			excerpt,
			provider: "exa",
			searchQuery: normalized.query,
			sourceId: optionalString(record.id, 500),
			score,
		});
	}
	if (discarded > 0 && results.length === 0) return malformed("results contained no parseable HTTP URLs");
	const cost = root.costDollars === undefined ? undefined : objectValue(root.costDollars, "costDollars", "exa");
	const costUsd = typeof cost?.total === "number" && Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : undefined;
	const bodyRequestId = optionalString(root.requestId, 500);
	return {
		query: normalized.query,
		results: results.slice(0, normalized.maxResults ?? 10),
		provider: "exa",
		appliedOptions: [],
		warnings: discarded > 0 ? [{ code: "partial-results", message: `Exa discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}` }] : [],
		...(metadata.requestId === undefined && bodyRequestId === undefined ? {} : { requestId: metadata.requestId ?? bodyRequestId }),
		...(costUsd === undefined ? {} : { usage: { costUsd } }),
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
