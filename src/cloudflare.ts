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
import {
	DEFAULT_SEARCH_PROVIDER_RESPONSE_BYTES,
	objectValue,
	optionalString,
	postJson,
	type JsonResponse,
	type SearchHttpFetch,
} from "./provider-http";
import { validateSearchRequest } from "./search";
import { normalizeSearchUrl } from "./search-cleanup";

export type CloudflareUpstream = "ceramic" | "exa" | "linkup";

export interface CloudflareAdapterOptions {
	/** Required even though Cloudflare itself defaults to Ceramic. */
	readonly upstream: CloudflareUpstream;
	readonly accountId?: string;
	readonly apiToken?: string;
	readonly gatewayId?: string;
	/** An explicit alias makes Cloudflare fail rather than fall back to gateway credits. */
	readonly byokAlias?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = { semantic: true, excerpts: true };
// BYOK agreements and gateway credits do not establish actual billed costs.
const profile: ProviderProfile = { auth: "environment", costModel: "unknown" };
const unsupportedOptions = [
	"domains", "dateRange", "social", "executionModel", "searchContextSize",
	"returnTokenBudget", "externalWebAccess", "userLocation", "searchContentTypes", "imageSettings",
] as const satisfies readonly SearchOption[];

function configurationError(message: string, kind: "auth" | "badRequest" = "badRequest"): never {
	throw createProviderError({ provider: "cloudflare", kind, message, retryable: false });
}

function requiredSetting(value: string | undefined, name: string, kind: "auth" | "badRequest"): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		return configurationError(`Cloudflare ${name} is not configured`, kind);
	}
	return value.trim();
}

function malformed(message: string): never {
	throw createProviderError({ provider: "cloudflare", kind: "malformed", message: `Cloudflare returned a malformed response (${message})`, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResponse(result: JsonResponse, request: SearchRequest, upstream: CloudflareUpstream): SearchResponse {
	const root = objectValue(result.payload, "response", "cloudflare");
	if (!Array.isArray(root.items)) return malformed("items is not an array");
	const metadata = isRecord(root.metadata) ? root.metadata : {};
	const query = request.query;
	const results: SearchResult[] = [];
	let discarded = 0;
	for (const item of root.items) {
		const parsed = isRecord(item) ? normalizeSearchUrl(item.url) : undefined;
		if (!isRecord(item) || parsed === undefined) {
			discarded += 1;
			continue;
		}
		results.push({
			...parsed,
			title: optionalString(item.title, 500),
			excerpt: optionalString(item.description, 4_000),
			// Keep both the gateway service and the selected upstream inspectable.
			provider: "cloudflare",
			upstreamProvider: upstream,
			searchQuery: query,
		});
	}
	if (discarded > 0 && results.length === 0) return malformed("items contained no parseable HTTP URLs");
	const requestId = result.requestId ?? optionalString(metadata.requestId, 500);
	const latencyMs = typeof metadata.latencyMs === "number" && Number.isFinite(metadata.latencyMs) && metadata.latencyMs >= 0 ? metadata.latencyMs : undefined;
	// imageUrl/faviconUrl have no evidence-result contract; lastModifiedDate is
	// not a publication date. Do not mislabel these optional documented fields.
	return {
		query,
		results: results.slice(0, request.maxResults ?? 10),
		provider: "cloudflare",
		upstreamProvider: upstream,
		appliedOptions: ["maxResults"],
		warnings: discarded > 0 ? [{ code: "partial-results", message: `Cloudflare discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}` }] : [],
		...(requestId === undefined ? {} : { requestId }),
		...(latencyMs === undefined ? {} : { latencyMs }),
		...(result.rateLimits === undefined ? {} : { usage: { rateLimits: result.rateLimits } }),
	};
}

export class CloudflareProvider implements Provider {
	readonly id = "cloudflare" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly upstream: CloudflareUpstream;
	private readonly accountId?: string;
	private readonly apiToken?: string;
	private readonly gatewayId: string;
	private readonly byokAlias?: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: CloudflareAdapterOptions) {
		this.upstream = options.upstream;
		this.accountId = options.accountId;
		this.apiToken = options.apiToken;
		this.gatewayId = options.gatewayId ?? "default";
		this.byokAlias = options.byokAlias;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_SEARCH_PROVIDER_RESPONSE_BYTES;
		if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
			throw new Error("Cloudflare maxResponseBytes must be a positive integer");
		}
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		if (normalized.query.length > 1_024) return configurationError("Cloudflare search query must be at most 1024 characters");
		if ((normalized.maxResults ?? 10) > 10) return configurationError("Cloudflare search maxResults must be at most 10");
		for (const option of unsupportedOptions) {
			if (normalized[option] !== undefined) {
				throw createProviderError({ provider: this.id, kind: "unsupported", message: `Cloudflare Web Search does not support ${option}`, retryable: false });
			}
		}
		if (!["ceramic", "exa", "linkup"].includes(this.upstream)) {
			return configurationError("Cloudflare upstream must be explicitly configured as ceramic, exa, or linkup");
		}
		const accountId = requiredSetting(this.accountId, "account ID", "auth");
		const apiToken = requiredSetting(this.apiToken, "API token", "auth");
		const gatewayId = requiredSetting(this.gatewayId, "gateway ID", "badRequest");
		if (this.byokAlias !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(this.byokAlias)) {
			return configurationError("Cloudflare byokAlias must contain 1-64 letters, digits, underscores, or hyphens");
		}
		const warnings: SearchWarning[] = normalized.mode === "keyword" || normalized.mode === "fresh"
			? [{ code: "unsupported-option", option: "mode", message: `Cloudflare Web Search does not guarantee ${normalized.mode === "keyword" ? "keyword-only ranking" : "freshness"}; the configured upstream uses its standard retrieval mode` }]
			: [];
		const result = await postJson({
			provider: this.id,
			url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/websearch/`,
			headers: { authorization: `Bearer ${apiToken}` },
			body: {
				query: normalized.query,
				provider: this.upstream,
				limit: normalized.maxResults,
				options: { gateway: { id: gatewayId } },
				...(this.byokAlias === undefined ? {} : { byokAlias: this.byokAlias }),
			},
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeResponse(result, normalized, this.upstream);
		return { ...response, warnings: [...warnings, ...response.warnings] };
	}
}

/** Register only for explicitly opted-in calls; this factory performs no I/O or global credential lookup. */
export function createCloudflareProvider(options: CloudflareAdapterOptions): CloudflareProvider {
	return new CloudflareProvider(options);
}
