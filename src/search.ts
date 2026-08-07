import type { Provider, ProviderContext, SearchProviderSelection, SearchRequest, SearchResponse } from "./contracts";
import { createProviderError, SearchToolError, toSearchToolError } from "./errors";
import { cleanupSearchResponse } from "./search-cleanup";

export const DEFAULT_MAX_RESULTS = 10;
export const MAX_RESULTS = 20;
export const MAX_QUERY_LENGTH = 2_000;
export const MAX_SEARCH_DOMAIN_LENGTH = 253;
export const MAX_SEARCH_DOMAIN_COUNT = 20;
export const MAX_SEARCH_DOMAIN_BYTES = 4_096;
export const MAX_EXECUTION_MODEL_LENGTH = 500;
export const MAX_SEARCH_HANDLE_COUNT = 20;
export const MAX_SEARCH_HANDLE_LENGTH = 15;
export const MAX_SEARCH_DATE_LENGTH = 64;
/** Native model-mediated search can spend tens of seconds grounding a query. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_CONTENT_RESULTS = 2;
/** Explicit source enrichment is finite and follows the public search-result bound. */
export const MAX_CONTENT_RESULTS = MAX_RESULTS;
export const DEFAULT_CONTENT_MAX_LENGTH = 4_000;
/** Keep search enrichment aligned with the fetcher's hard 32-KB output bound. */
export const MAX_CONTENT_MAX_LENGTH = 32_000;

function invalidRequest(message: string): SearchToolError {
	return new SearchToolError("WEB_SEARCH_INVALID_REQUEST", message);
}

export function normalizeSearchDomain(value: string, field = "domain"): string {
	const domain = value.trim().toLowerCase();
	if (
		domain.length === 0 ||
		domain.length > MAX_SEARCH_DOMAIN_LENGTH ||
		!domain.includes(".") ||
		domain.includes("..") ||
		!domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
	) {
		throw invalidRequest(`Search ${field} must be a hostname without a scheme, path, port, or operators`);
	}
	return domain;
}

function normalizeDomainList(value: readonly string[] | undefined, field: string): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw invalidRequest(`Search ${field} must be an array of domain strings`);
	}
	if (value.length > MAX_SEARCH_DOMAIN_COUNT) {
		throw invalidRequest(`Search ${field} must contain at most ${MAX_SEARCH_DOMAIN_COUNT} domains`);
	}
	let totalBytes = 0;
	const domains = value.map((domain, index) => {
		if (typeof domain !== "string" || domain.trim().length === 0) {
			throw invalidRequest(`Search ${field}[${index}] must be a non-empty string`);
		}
		const normalized = normalizeSearchDomain(domain, `${field}[${index}]`);
		totalBytes += new TextEncoder().encode(normalized).byteLength;
		if (totalBytes > MAX_SEARCH_DOMAIN_BYTES) {
			throw invalidRequest(`Search ${field} exceeds the ${MAX_SEARCH_DOMAIN_BYTES}-byte aggregate limit`);
		}
		return normalized;
	});
	return [...new Set(domains)];
}

function normalizeDate(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) throw invalidRequest(`Search ${field} must be an ISO-8601 date or date-time`);
	const normalized = value.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2}))?$/.exec(normalized);
	if (normalized.length > MAX_SEARCH_DATE_LENGTH || match === null) throw invalidRequest(`Search ${field} must be an ISO-8601 date or date-time`);
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = hourText === undefined ? 0 : Number(hourText);
	const minute = minuteText === undefined ? 0 : Number(minuteText);
	const second = secondText === undefined ? 0 : Number(secondText);
	const offset = offsetText === undefined || offsetText === "Z" ? undefined : offsetText.replace(":", "");
	const offsetHour = offset === undefined ? 0 : Number(offset.slice(1, 3));
	const offsetMinute = offset === undefined ? 0 : Number(offset.slice(3, 5));
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (
		month < 1 || month > 12 || day < 1 || day > daysInMonth ||
		hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 ||
		offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(Date.parse(normalized))
	) {
		throw invalidRequest(`Search ${field} must be an ISO-8601 date or date-time`);
	}
	return normalized;
}

function normalizeDateRange(value: SearchRequest["dateRange"]): SearchRequest["dateRange"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest("Search dateRange must be an object");
	const from = normalizeDate(value.from, "dateRange.from");
	const to = normalizeDate(value.to, "dateRange.to");
	if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) throw invalidRequest("Search dateRange.from must not be later than dateRange.to");
	if (from === undefined && to === undefined) return undefined;
	return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

function normalizeHandles(value: readonly string[] | undefined, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw invalidRequest(`Search ${field} must be an array of X handles`);
	if (value.length > MAX_SEARCH_HANDLE_COUNT) throw invalidRequest(`Search ${field} must contain at most ${MAX_SEARCH_HANDLE_COUNT} handles`);
	const handles = value.map((handle, index) => {
		if (typeof handle !== "string") throw invalidRequest(`Search ${field}[${index}] must be a string`);
		const normalized = handle.trim().replace(/^@/, "").toLowerCase();
		if (normalized.length === 0 || normalized.length > MAX_SEARCH_HANDLE_LENGTH || !/^[A-Za-z0-9_]+$/.test(normalized)) {
			throw invalidRequest(`Search ${field}[${index}] must be an X handle without spaces or punctuation`);
		}
		return normalized;
	});
	return [...new Set(handles)];
}

function normalizeSocial(value: SearchRequest["social"]): SearchRequest["social"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest("Search social must be an object");
	if (value.understandImages !== undefined && typeof value.understandImages !== "boolean") throw invalidRequest("Search social.understandImages must be a boolean");
	if (value.understandVideos !== undefined && typeof value.understandVideos !== "boolean") throw invalidRequest("Search social.understandVideos must be a boolean");
	const includeHandles = normalizeHandles(value.includeHandles, "social.includeHandles");
	const excludeHandles = normalizeHandles(value.excludeHandles, "social.excludeHandles");
	if (includeHandles !== undefined && excludeHandles !== undefined) {
		const excluded = new Set(excludeHandles);
		const overlap = includeHandles.find((handle) => excluded.has(handle));
		if (overlap !== undefined) throw invalidRequest(`Search social handle cannot be both included and excluded: ${overlap}`);
	}
	if (includeHandles === undefined && excludeHandles === undefined && value.understandImages === undefined && value.understandVideos === undefined) return undefined;
	return {
		...(includeHandles === undefined ? {} : { includeHandles }),
		...(excludeHandles === undefined ? {} : { excludeHandles }),
		...(value.understandImages === undefined ? {} : { understandImages: value.understandImages }),
		...(value.understandVideos === undefined ? {} : { understandVideos: value.understandVideos }),
	};
}

/** Validate and normalize the public search request before any provider call. */
export function validateSearchRequest(request: SearchRequest): SearchRequest {
	if (request === null || typeof request !== "object") {
		throw invalidRequest("Search request must be an object");
	}
	if (typeof request.query !== "string") {
		throw invalidRequest("Search query must be a string");
	}
	const query = request.query.trim();
	if (query.length === 0) {
		throw invalidRequest("Search query must not be empty");
	}
	if (query.length > MAX_QUERY_LENGTH) {
		throw invalidRequest(`Search query must be at most ${MAX_QUERY_LENGTH} characters`);
	}

	const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;
	if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
		throw invalidRequest(`Search maxResults must be an integer between 1 and ${MAX_RESULTS}`);
	}
	if (request.executionModel !== undefined && typeof request.executionModel !== "string") throw invalidRequest("Search executionModel must be a string");
	const executionModel = request.executionModel === undefined ? undefined : request.executionModel.trim();
	if (executionModel !== undefined && (executionModel.length === 0 || executionModel.length > MAX_EXECUTION_MODEL_LENGTH)) {
		throw invalidRequest(`Search executionModel must be between 1 and ${MAX_EXECUTION_MODEL_LENGTH} characters`);
	}
	const dateRange = normalizeDateRange(request.dateRange);
	const social = normalizeSocial(request.social);
	const answerMode = request.answerMode ?? "auto";
	if (answerMode !== "auto" && answerMode !== "evidence") {
		throw invalidRequest("Search answerMode must be auto or evidence");
	}
	const includeContent = request.includeContent ?? false;
	if (typeof includeContent !== "boolean") throw invalidRequest("Search includeContent must be a boolean");
	const contentResults = request.contentResults ?? DEFAULT_CONTENT_RESULTS;
	if (!Number.isInteger(contentResults) || contentResults < 1 || contentResults > MAX_CONTENT_RESULTS) {
		throw invalidRequest(`Search contentResults must be an integer between 1 and ${MAX_CONTENT_RESULTS}`);
	}
	const contentMaxLength = request.contentMaxLength ?? DEFAULT_CONTENT_MAX_LENGTH;
	if (!Number.isInteger(contentMaxLength) || contentMaxLength < 1 || contentMaxLength > MAX_CONTENT_MAX_LENGTH) {
		throw invalidRequest(`Search contentMaxLength must be an integer between 1 and ${MAX_CONTENT_MAX_LENGTH}`);
	}

	if (
		request.domains !== undefined &&
		(typeof request.domains !== "object" || request.domains === null || Array.isArray(request.domains))
	) {
		throw invalidRequest("Search domains must be an object");
	}
	const include = normalizeDomainList(request.domains?.include, "domains.include");
	const exclude = normalizeDomainList(request.domains?.exclude, "domains.exclude");
	if (include !== undefined && exclude !== undefined) {
		const excluded = new Set(exclude);
		const overlap = include.find((domain) => excluded.has(domain));
		if (overlap !== undefined) {
			throw invalidRequest(`Search domain cannot be both included and excluded: ${overlap}`);
		}
	}
	return {
		...request,
		query,
		mode: request.mode ?? "auto",
		maxResults,
		...(executionModel === undefined ? {} : { executionModel }),
		...(dateRange === undefined ? {} : { dateRange }),
		...(social === undefined ? {} : { social }),
		answerMode,
		includeContent,
		contentResults,
		contentMaxLength,
		...(include === undefined && exclude === undefined
			? { domains: request.domains }
			: { domains: { ...(include === undefined ? {} : { include }), ...(exclude === undefined ? {} : { exclude }) } }),
	};
}

export interface ExecuteSearchOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly context?: ProviderContext;
}

/** Execute one provider call with caller cancellation and a hard deadline. */
export async function executeSearch(
	provider: Provider,
	request: SearchRequest,
	options: ExecuteSearchOptions = {},
): Promise<SearchResponse> {
	const normalized = validateSearchRequest(request);
	const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw invalidRequest("Search timeoutMs must be positive");
	}
	if (options.signal?.aborted) {
		throw toSearchToolError(
			createProviderError({
				provider: provider.id,
				kind: "canceled",
				message: "Search canceled",
				retryable: false,
			}),
			provider.id,
		);
	}

	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let rejectCanceled: ((error: SearchToolError) => void) | undefined;
	const canceled = new Promise<never>((_, reject) => {
		rejectCanceled = reject;
	});
	const onAbort = () => {
		controller.abort(options.signal?.reason);
		rejectCanceled?.(
			toSearchToolError(
				createProviderError({
					provider: provider.id,
					kind: "canceled",
					message: "Search canceled",
					retryable: false,
				}),
				provider.id,
			),
		);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let rejectTimedOut: ((error: SearchToolError) => void) | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		rejectTimedOut = reject;
		timeoutId = setTimeout(() => {
			controller.abort();
			rejectTimedOut?.(
				toSearchToolError(
					createProviderError({
						provider: provider.id,
						kind: "timeout",
						message: `Search timed out after ${timeoutMs}ms`,
						retryable: true,
					}),
					provider.id,
				),
			);
		}, timeoutMs);
	});

	const providerCall = Promise.resolve().then(() => provider.search(normalized, controller.signal, options.context ?? {}));
	try {
		const response = await Promise.race([providerCall, timedOut, canceled]);
		return cleanupSearchResponse(response, normalized, provider.id);
	} catch (error) {
		throw toSearchToolError(error, provider.id);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function canUseAutomaticFallback(error: unknown): boolean {
	if (!(error instanceof SearchToolError)) return false;
	// A successful provider request can be billed before a network, timeout, or
	// 5xx error reaches us. Only failures that are known to have been rejected
	// or prevented from dispatching may consume the bounded alternative.
	return error.kind === "auth" || error.kind === "rateLimit" || error.kind === "unavailable";
}

/** Execute an automatic selection with at most one visible alternative. */
export async function executeSearchSelection(
	selection: SearchProviderSelection,
	request: SearchRequest,
	options: ExecuteSearchOptions = {},
): Promise<SearchResponse> {
	const normalized = validateSearchRequest(request);
	const candidates = [selection.provider, ...(selection.automatic ? selection.fallbacks.slice(0, 1) : [])];
	let firstError: SearchToolError | undefined;
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index]!;
		try {
			const response = await executeSearch(candidate, normalized, options);
			const attemptedProviders = candidates.slice(0, index + 1).map((provider) => provider.id);
			if (index === 0) return { ...response, attemptedProviders };
			return {
				...response,
				attemptedProviders,
				warnings: [
					...response.warnings,
					{ code: "provider-fallback", message: `Provider ${candidates[0]!.id} failed; used ${candidate.id} as the bounded automatic fallback` },
				],
			};
		} catch (error) {
			const toolError = error instanceof SearchToolError ? error : toSearchToolError(error, candidate.id);
			if (index === 0) firstError = toolError;
			if (index === 0 && selection.automatic && selection.fallbacks.length > 0 && canUseAutomaticFallback(toolError)) continue;
			if (firstError !== undefined && index > 0) {
				throw new SearchToolError(toolError.code, `${toolError.message}; primary provider ${selection.provider.id} also failed: ${firstError.message}`, {
					provider: toolError.provider,
					kind: toolError.kind,
					retryable: toolError.retryable,
					status: toolError.status,
					requestId: toolError.requestId,
					retryAfterMs: toolError.retryAfterMs,
					rateLimits: toolError.rateLimits,
				});
			}
			throw toolError;
		}
	}
	throw firstError ?? new SearchToolError("WEB_SEARCH_UNKNOWN", "Search failed");
}
