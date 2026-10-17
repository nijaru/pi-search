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
	if (request.imageSettings !== undefined) unsupported("DeepSeek search does not expose image result settings");
	if (request.searchContentTypes !== undefined) unsupported("DeepSeek search does not expose content-type selection");
}

/** The UTC calendar day for an ISO-8601 date or instant; operators are day-based. */
function utcDatePart(value: string): string {
	return new Date(Date.parse(value)).toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD date in UTC. */
function shiftDate(day: string, deltaDays: number): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(Date.UTC(year!, month! - 1, date! + deltaDays)).toISOString().slice(0, 10);
}

/**
 * DeepSeek's `after:`/`before:` operators are date boundaries, while the
 * request contract uses inclusive bounds. Widen each boundary by one day so
 * the provider window cannot exclude the requested boundary days; the exact
 * inclusive range is then enforced locally for results that report a date.
 */
function dateOperators(request: SearchRequest): { readonly operators: string[]; readonly widened: boolean } {
	const operators: string[] = [];
	let widened = false;
	const from = request.dateRange?.from;
	const to = request.dateRange?.to;
	if (from !== undefined) {
		if (from.includes("T")) widened = true;
		operators.push(`after:${shiftDate(utcDatePart(from), -1)}`);
	}
	if (to !== undefined) {
		if (to.includes("T")) widened = true;
		operators.push(`before:${shiftDate(utcDatePart(to), 1)}`);
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
		warnings.push({ code: "unsupported-option", option: "dateRange", message: "DeepSeek date operators have day granularity; time-of-day bounds are enforced locally on results that report a date" });
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
			count: normalized.maxResults ?? 10,
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

/** Inclusive UTC day boundaries for date-only bounds; exact instants otherwise. */
function boundaryMs(value: string, endOfDay: boolean): number | undefined {
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) return undefined;
	return endOfDay && !value.includes("T") ? milliseconds + 86_400_000 - 1 : milliseconds;
}

/**
 * The date operators widen the provider window to protect inclusive boundary
 * days, so enforce the exact inclusive range on results whose date is known.
 * Results without a date cannot be checked and remain visible with a warning.
 */
function filterByDateRange(
	results: readonly SearchResult[],
	request: SearchRequest,
): { readonly results: readonly SearchResult[]; readonly removed: number; readonly unverified: number } {
	const fromMs = request.dateRange?.from === undefined ? undefined : boundaryMs(request.dateRange.from, false);
	const toMs = request.dateRange?.to === undefined ? undefined : boundaryMs(request.dateRange.to, true);
	if (fromMs === undefined && toMs === undefined) return { results, removed: 0, unverified: 0 };
	const kept: SearchResult[] = [];
	let removed = 0;
	let unverified = 0;
	for (const result of results) {
		const publishedMs = result.publishedAt === undefined ? Number.NaN : Date.parse(result.publishedAt);
		if (!Number.isFinite(publishedMs)) {
			unverified += 1;
			kept.push(result);
			continue;
		}
		if ((fromMs !== undefined && publishedMs < fromMs) || (toMs !== undefined && publishedMs > toMs)) {
			removed += 1;
			continue;
		}
		kept.push(result);
	}
	return { results: kept, removed, unverified };
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
	const dateFiltered = filterByDateRange(results, normalized);
	const warnings: SearchWarning[] = [];
	if (discarded > 0) {
		warnings.push({ code: "partial-results", message: `DeepSeek discarded ${discarded} malformed result entr${discarded === 1 ? "y" : "ies"}` });
	}
	if (dateFiltered.removed > 0) {
		warnings.push({ code: "partial-results", message: `DeepSeek removed ${dateFiltered.removed} result entr${dateFiltered.removed === 1 ? "y" : "ies"} outside the requested date range` });
	}
	if (dateFiltered.unverified > 0) {
		warnings.push({ code: "partial-results", message: `DeepSeek could not verify the publication date of ${dateFiltered.unverified} result entr${dateFiltered.unverified === 1 ? "y" : "ies"} against the requested date range` });
	}
	return {
		query: normalized.query,
		results: dateFiltered.results.slice(0, normalized.maxResults ?? 10),
		provider: "deepseek",
		appliedOptions: [],
		warnings,
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
