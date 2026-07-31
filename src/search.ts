import type { Provider, ProviderContext, SearchRequest, SearchResponse } from "./contracts";
import { createProviderError, SearchToolError, toSearchToolError } from "./errors";

export const DEFAULT_MAX_RESULTS = 10;
export const MAX_RESULTS = 20;
export const MAX_QUERY_LENGTH = 2_000;
export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

function invalidRequest(message: string): SearchToolError {
	return new SearchToolError("WEB_SEARCH_INVALID_REQUEST", message);
}

export function normalizeSearchDomain(value: string, field = "domain"): string {
	const domain = value.trim().toLowerCase();
	if (
		domain.length === 0 ||
		domain.length > 253 ||
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
	const domains = value.map((domain, index) => {
		if (typeof domain !== "string" || domain.trim().length === 0) {
			throw invalidRequest(`Search ${field}[${index}] must be a non-empty string`);
		}
		return normalizeSearchDomain(domain, `${field}[${index}]`);
	});
	return [...new Set(domains)];
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
		return await Promise.race([providerCall, timedOut, canceled]);
	} catch (error) {
		throw toSearchToolError(error, provider.id);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
		options.signal?.removeEventListener("abort", onAbort);
	}
}
