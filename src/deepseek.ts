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
import { httpSource, objectValue, optionalString, optionalTimestamp, postJson, requireApiKey, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

export const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
export const DEFAULT_DEEPSEEK_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Current published price for one successful Search API request. */
export const DEEPSEEK_ESTIMATED_SEARCH_COST_USD = 0.00075;
/** DeepSeek rejects requests outside this range; pi-search already caps results at 20. */
export const DEEPSEEK_MAX_RESULTS = 50;
/** DeepSeek counts query characters, including any operator clauses. */
export const DEEPSEEK_MAX_QUERY_LENGTH = 128;
const DEEPSEEK_MAX_SCORE = 3;

export interface DeepSeekAdapterOptions {
	readonly apiKey?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

// DeepSeek's search index is a general web index with its own authority and
// freshness ranking. It exposes no dedicated social, media, context, or
// location controls, so those requests are rejected rather than degraded.
const capabilities: ProviderCapabilities = {
	keyword: true,
	freshness: true,
	excerpts: true,
	domainFilter: true,
	dateFilter: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "per-request",
	estimatedCostUsd: DEEPSEEK_ESTIMATED_SEARCH_COST_USD,
};

function unsupported(message: string): never {
	throw createProviderError({ provider: "deepseek", kind: "unsupported", message, retryable: false });
}

function acceptRequestOptions(request: SearchRequest): void {
	if (request.social !== undefined) unsupported("DeepSeek search does not provide dedicated social/X constraints");
	if (request.executionModel !== undefined) unsupported("DeepSeek search is a direct provider and does not accept an execution model");
	if (request.searchContextSize !== undefined) unsupported("DeepSeek search does not expose provider-native search context sizing");
	if (request.returnTokenBudget !== undefined) unsupported("DeepSeek search does not expose a returned-token budget");
	if (request.externalWebAccess !== undefined) unsupported("DeepSeek search does not expose live/cache-only selection");
	if (request.userLocation !== undefined) unsupported("DeepSeek search does not expose a user location contract");
	if (request.searchContentTypes !== undefined) unsupported("DeepSeek search does not expose content-type selection");
	if (request.imageSettings !== undefined) unsupported("DeepSeek search does not expose image result settings");
}

function datePart(value: string): string {
	return value.slice(0, 10);
}

/** Shift a YYYY-MM-DD date in UTC. */
function shiftDate(day: string, deltaDays: number): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(Date.UTC(year!, month! - 1, date! + deltaDays)).toISOString().slice(0, 10);
}

/**
 * DeepSeek's `after:`/`before:` operators are date boundaries, while the
 * request contract uses inclusive bounds. Shift each boundary by one day so
 * the provider window contains the requested inclusive range, and report the
 * loss of any time-of-day precision instead of silently narrowing it.
 */
function dateOperators(request: SearchRequest): { readonly operators: string[]; readonly widened: boolean } {
	const operators: string[] = [];
	let widened = false;
	const from = request.dateRange?.from;
	const to = request.dateRange?.to;
	if (from !== undefined) {
		if (from.includes("T")) widened = true;
		operators.push(`after:${shiftDate(datePart(from), -1)}`);
	}
	if (to !== undefined) {
		if (to.includes("T")) widened = true;
		operators.push(`before:${shiftDate(datePart(to), 1)}`);
	}
	return { operators, widened };
}

function domainClauses(request: SearchRequest): string[] {
	const include = request.domains?.include ?? [];
	const exclude = request.domains?.exclude ?? [];
	const clauses: string[] = [];
	// DeepSeek documents multiple allowed sites as `site:a OR site:b` clauses
	// joined by OR rather than a parenthesized group.
	if (include.length > 0) clauses.push(include.map((domain) => `site:${domain}`).join(" OR "));
	clauses.push(...exclude.map((domain) => `-site:${domain}`));
	return clauses;
}

export interface DeepSeekRequestPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

export function buildDeepSeekRequest(request: SearchRequest): DeepSeekRequestPlan {
	const normalized = validateSearchRequest(request);
	acceptRequestOptions(normalized);

	const appliedOptions: SearchOption[] = ["maxResults", "mode"];
	const warnings: SearchWarning[] = [];
	if (normalized.domains?.include !== undefined || normalized.domains?.exclude !== undefined) appliedOptions.push("domains");
	if (normalized.dateRange !== undefined) appliedOptions.push("dateRange");

	if (normalized.mode === "keyword") {
		warnings.push({ code: "unsupported-option", option: "mode", message: "DeepSeek search reranks by its own relevance and authority signals; keyword-only ranking is not guaranteed" });
	}
	if (normalized.mode === "fresh" && normalized.dateRange?.from === undefined) {
		warnings.push({ code: "unsupported-option", option: "mode", message: "DeepSeek search can return recent sources but this request does not impose a recent-date floor" });
	}

	const dates = dateOperators(normalized);
	if (dates.widened) {
		warnings.push({ code: "unsupported-option", option: "dateRange", message: "DeepSeek applies day-granularity publication bounds; time-of-day components were widened to whole days" });
	}

	const query = [normalized.query, ...domainClauses(normalized), ...dates.operators].filter((part) => part.length > 0).join(" ");
	// Count Unicode code points, matching DeepSeek's own limit rather than
	// JavaScript's UTF-16 length.
	if ([...query].length > DEEPSEEK_MAX_QUERY_LENGTH) {
		throw createProviderError({
			provider: "deepseek",
			kind: "unsupported",
			fallbackSafe: true,
			message: `DeepSeek limits queries to ${DEEPSEEK_MAX_QUERY_LENGTH} characters including site/date operators; the composed query is ${[...query].length} characters`,
			retryable: false,
		});
	}

	return {
		body: {
			query,
			count: Math.min(normalized.maxResults ?? 10, DEEPSEEK_MAX_RESULTS),
			// DeepSeek returns a model-oriented summary regardless; full page
			// content stays the job of the local web_fetch path.
			need_content: false,
		},
		appliedOptions,
		warnings,
	};
}

function malformed(message: string): never {
	throw createProviderError({ provider: "deepseek", kind: "malformed", message: `DeepSeek returned a malformed response (${message})`, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scoreFromResult(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value / DEEPSEEK_MAX_SCORE));
}

function excerptFromRecord(record: Record<string, unknown>): string | undefined {
	// `summary` is the 600-800 character text DeepSeek intends models to read;
	// `snippet` is the shorter display string.
	return optionalString(record.summary, 4_000) ?? optionalString(record.snippet, 4_000);
}

export function normalizeDeepSeekResponse(
	payload: unknown,
	request: SearchRequest,
	options: { readonly requestId?: string; readonly rateLimits?: ProviderRateLimitInfo } = {},
): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "deepseek");
	if (!Array.isArray(root.results)) return malformed("results is not an array");
	const results: SearchResult[] = [];
	let discarded = 0;
	for (const value of root.results) {
		// A single malformed entry should not hide otherwise usable evidence.
		if (!isRecord(value)) {
			discarded += 1;
			continue;
		}
		const parsed = httpSource(value.url, "deepseek");
		if (parsed === undefined) {
			discarded += 1;
			continue;
		}
		results.push({
			url: parsed.url,
			title: optionalString(value.title, 500),
			domain: parsed.domain,
			publishedAt: optionalTimestamp(value.date),
			excerpt: excerptFromRecord(value),
			provider: "deepseek",
			searchQuery: normalized.query,
			score: scoreFromResult(value.rerank_score),
		});
	}
	if (discarded > 0 && results.length === 0) return malformed("results contained no parseable HTTP URLs");
	return {
		query: normalized.query,
		results: results.slice(0, normalized.maxResults ?? 10),
		provider: "deepseek",
		appliedOptions: [],
		warnings: discarded > 0 ? [{ code: "partial-results", message: `DeepSeek discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}` }] : [],
		...(options.requestId === undefined ? {} : { requestId: options.requestId }),
		...(options.rateLimits === undefined ? {} : { usage: { rateLimits: options.rateLimits } }),
	};
}

export class DeepSeekProvider implements Provider {
	readonly id = "deepseek" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: DeepSeekAdapterOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? DEEPSEEK_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_DEEPSEEK_RESPONSE_BYTES;
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildDeepSeekRequest(normalized);
		const result = await postJson({
			provider: this.id,
			url: this.endpoint,
			headers: { authorization: `Bearer ${requireApiKey(this.id, this.apiKey)}` },
			body: plan.body,
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeDeepSeekResponse(result.payload, normalized, result);
		return { ...response, appliedOptions: plan.appliedOptions, warnings: [...plan.warnings, ...response.warnings] };
	}
}

export function createDeepSeekProvider(options: DeepSeekAdapterOptions): DeepSeekProvider {
	return new DeepSeekProvider(options);
}
