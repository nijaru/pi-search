import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderRateLimitInfo,
	ProviderRateLimitWindow,
	ProviderProfile,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchWarning,
} from "./contracts";
import { createProviderError, isProviderError } from "./errors";
import { cancelResponseBody, readBoundedResponseText } from "./http";
import { validateSearchRequest } from "./search";

export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const DEFAULT_BRAVE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BRAVE_MAX_RESULTS = 20;

export type BraveFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BraveCapacityTracker {
	/** True when no known finite quota window currently blocks a call. */
	readonly canAttempt: () => boolean;
	/** Record provider observations without inventing or persisting counters. */
	readonly observe: (info: ProviderRateLimitInfo | undefined) => void;
	/** Return the latest immutable observation for diagnostics and errors. */
	readonly snapshot: () => ProviderRateLimitInfo | undefined;
}

/**
 * Tracks only provider-reported windows. The provider remains authoritative;
 * this is a local admission guard, not a quota counter or billing ledger.
 */
export class BraveQuotaTracker implements BraveCapacityTracker {
	private latest: ProviderRateLimitInfo | undefined;
	private observedAtMs = 0;

	canAttempt(): boolean {
		const info = this.snapshot();
		if (info === undefined) return true;
		if (info.retryAfterMs !== undefined && info.retryAfterMs > 0) return false;
		return !info.windows.some((window) => {
			// Some providers use a zero limit to mean that this window is not
			// enforced. It must not become a permanent local denial.
			if (window.limit === 0 || window.remaining !== 0) return false;
			if (window.resetAfterMs !== undefined) return window.resetAfterMs > 0;
			if (window.resetAt !== undefined) {
				const resetAt = Date.parse(window.resetAt);
				return Number.isFinite(resetAt) && resetAt > Date.now();
			}
			return true;
		});
	}

	observe(info: ProviderRateLimitInfo | undefined): void {
		if (info !== undefined && (info.windows.length > 0 || info.retryAfterMs !== undefined)) {
			this.latest = info;
			this.observedAtMs = Date.now();
		}
	}

	snapshot(): ProviderRateLimitInfo | undefined {
		if (this.latest === undefined) return undefined;
		const elapsedMs = Math.max(0, Date.now() - this.observedAtMs);
		return {
			windows: this.latest.windows.map((window) => ({
				...window,
				...(window.resetAfterMs === undefined ? {} : { resetAfterMs: Math.max(0, window.resetAfterMs - elapsedMs) }),
			})),
			...(this.latest.retryAfterMs === undefined ? {} : { retryAfterMs: Math.max(0, this.latest.retryAfterMs - elapsedMs) }),
		};
	}
}

export interface BraveAdapterOptions {
	/** The key is supplied by the construction boundary; never read globally here. */
	readonly apiKey?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: BraveFetch;
	readonly maxResponseBytes?: number;
	readonly capacityTracker?: BraveCapacityTracker;
}

interface BraveResultPayload {
	readonly title?: unknown;
	readonly url?: unknown;
	readonly description?: unknown;
	readonly snippet?: unknown;
	readonly published?: unknown;
	readonly page_age?: unknown;
}

const capabilities: ProviderCapabilities = {
	keyword: true,
	freshness: true,
	excerpts: true,
	domainFilter: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "per-request",
};

function malformed(message: string, cause?: unknown): never {
	throw createProviderError({
		provider: "brave",
		kind: "malformed",
		message: `Brave returned a malformed response (${message})`,
		retryable: false,
		cause,
	});
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return malformed(`${label} is not an object`);
	}
	return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string, maxLength = 8_192): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return malformed(`${label} is not a string`);
	return value.slice(0, maxLength);
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	const candidate = optionalString(value, label, 100);
	if (candidate === undefined) return undefined;
	return Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function normalizedUrl(value: unknown): { url: string; domain: string } {
	if (typeof value !== "string" || value.trim().length === 0) return malformed("web.results[].url is missing");
	if (value.length > 8_192) return malformed("web.results[].url exceeds the supported length limit");
	const raw = value.trim();
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return malformed("web.results[].url is not an HTTP(S) URL");
		}
		return { url: url.toString(), domain: url.hostname.toLowerCase().replace(/\.$/, "") };
	} catch (error) {
		return malformed("web.results[].url is not a valid URL", error);
	}
}

function domainMatches(hostname: string, domain: string): boolean {
	const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
	const normalizedDomain = domain.toLowerCase().replace(/\.$/, "");
	return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

function resultAllowed(result: SearchResult, request: SearchRequest): boolean {
	const include = request.domains?.include;
	const exclude = request.domains?.exclude;
	const domain = result.domain ?? new URL(result.url).hostname.toLowerCase();
	if (include !== undefined && include.length > 0 && !include.some((candidate) => domainMatches(domain, candidate))) {
		return false;
	}
	return exclude === undefined || !exclude.some((candidate) => domainMatches(domain, candidate));
}

function resultFromPayload(value: unknown, query: string): SearchResult {
	const result = objectValue(value, "web.results[]") as BraveResultPayload;
	const parsed = normalizedUrl(result.url);
	const title = optionalString(result.title, "web.results[].title", 500);
	const description = optionalString(result.description ?? result.snippet, "web.results[].description", 4_000);
	const publishedAt = optionalTimestamp(result.published ?? result.page_age, "web.results[].published");
	return {
		url: parsed.url,
		...(title === undefined ? {} : { title }),
		domain: parsed.domain,
		...(publishedAt === undefined ? {} : { publishedAt }),
		...(description === undefined ? {} : { excerpt: description }),
		provider: "brave",
		searchQuery: query,
	};
}

function parseNonNegative(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function splitHeader(value: string | null): string[] {
	return value === null ? [] : value.split(",").map((part) => part.trim());
}

function parseReset(value: string | undefined): Pick<ProviderRateLimitWindow, "resetAt" | "resetAfterMs"> {
	if (value === undefined) return {};
	const numeric = parseNonNegative(value);
	if (numeric === undefined) return {};
	if (numeric >= 1_000_000_000_000) {
		return { resetAt: new Date(numeric).toISOString() };
	}
	if (numeric >= 1_000_000_000) {
		return { resetAt: new Date(numeric * 1_000).toISOString() };
	}
	return { resetAfterMs: Math.round(numeric * 1_000) };
}

/** Parse common Brave quota headers without assuming a single plan window. */
export function parseBraveRateLimits(headers: Headers): ProviderRateLimitInfo | undefined {
	const limits = splitHeader(headers.get("x-ratelimit-limit"));
	const remaining = splitHeader(headers.get("x-ratelimit-remaining"));
	const resets = splitHeader(headers.get("x-ratelimit-reset"));
	const count = Math.max(limits.length, remaining.length, resets.length);
	const windows: ProviderRateLimitWindow[] = [];
	for (let index = 0; index < count; index += 1) {
		const limit = parseNonNegative(limits[index] ?? "");
		const left = parseNonNegative(remaining[index] ?? "");
		const reset = parseReset(resets[index]);
		if (limit === undefined && left === undefined && Object.keys(reset).length === 0) continue;
		windows.push({
			...(limit === undefined ? {} : { limit }),
			...(left === undefined ? {} : { remaining: left }),
			...reset,
			scope: `window-${index}`,
		});
	}
	const retryAfter = headers.get("retry-after");
	let retryAfterMs: number | undefined;
	if (retryAfter !== null) {
		const seconds = parseNonNegative(retryAfter);
		if (seconds !== undefined) retryAfterMs = Math.round(seconds * 1_000);
		else {
			const date = Date.parse(retryAfter);
			if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - Date.now());
		}
	}
	if (windows.length === 0 && retryAfterMs === undefined) return undefined;
	return { windows, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function domainQuery(request: SearchRequest): string {
	const include = request.domains?.include ?? [];
	const exclude = request.domains?.exclude ?? [];
	const includeQuery = include.length === 0 ? undefined : include.length === 1 ? `site:${include[0]}` : `(${include.map((domain) => `site:${domain}`).join(" OR ")})`;
	const excludeQuery = exclude.map((domain) => `-site:${domain}`);
	return [includeQuery, request.query, ...excludeQuery].filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

export interface BraveRequestPlan {
	readonly url: string;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

/** Build one bounded Brave request; no pagination or hidden follow-up calls. */
export function buildBraveRequest(request: SearchRequest, endpoint = BRAVE_SEARCH_ENDPOINT): BraveRequestPlan {
	const normalized = validateSearchRequest(request);
	const appliedOptions: SearchOption[] = ["maxResults"];
	const warnings: SearchWarning[] = [];
	const params = new URLSearchParams({
		q: domainQuery(normalized),
		count: String(Math.min(normalized.maxResults ?? 10, BRAVE_MAX_RESULTS)),
	});
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) appliedOptions.push("domains");
	switch (normalized.mode) {
		case "auto":
		case "keyword":
			appliedOptions.push("mode");
			break;
		case "fresh":
			params.set("freshness", "pm");
			appliedOptions.push("mode");
			break;
		default:
			break;
	}
	return { url: `${endpoint}?${params.toString()}`, appliedOptions, warnings };
}

export function normalizeBraveResponse(
	payload: unknown,
	request: SearchRequest,
	options: { readonly requestId?: string; readonly rateLimits?: ProviderRateLimitInfo } = {},
): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response");
	const web = objectValue(root.web, "web");
	if (!Array.isArray(web.results)) return malformed("web.results is not an array");
	const results = web.results
		.map((value) => resultFromPayload(value, normalized.query))
		.filter((result) => resultAllowed(result, normalized))
		.slice(0, normalized.maxResults);
	return {
		query: normalized.query,
		results,
		provider: "brave",
		appliedOptions: [],
		warnings: [],
		...(options.requestId === undefined ? {} : { requestId: options.requestId }),
		...(options.rateLimits === undefined ? {} : { usage: { rateLimits: options.rateLimits } }),
	};
}

export class BraveProvider implements Provider {
	readonly id = "brave" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: BraveFetch;
	private readonly maxResponseBytes: number;
	private readonly capacityTracker?: BraveCapacityTracker;

	constructor(options: BraveAdapterOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? BRAVE_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as BraveFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_BRAVE_RESPONSE_BYTES;
		this.capacityTracker = options.capacityTracker;
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildBraveRequest(normalized, this.endpoint);
		if (signal.aborted) {
			throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false });
		}
		const observed = this.capacityTracker?.snapshot();
		if (this.capacityTracker !== undefined && !this.capacityTracker.canAttempt()) {
			throw createProviderError({
				provider: this.id,
				kind: "rateLimit",
				message: "Brave quota window is exhausted",
				retryable: true,
				rateLimits: observed,
				retryAfterMs: observed?.retryAfterMs,
			});
		}
		const apiKey = this.apiKey;
		if (apiKey === undefined || apiKey.trim().length === 0) {
			throw createProviderError({ provider: this.id, kind: "auth", message: "Brave API key is not configured", retryable: false });
		}

		let response: Response;
		try {
			response = await this.fetchImpl(plan.url, {
			method: "GET",
			headers: { accept: "application/json", "x-subscription-token": apiKey },
			signal,
		});
		} catch (error) {
			if (signal.aborted) {
				throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false, cause: error });
			}
			if (isProviderError(error)) throw error;
			throw createProviderError({ provider: this.id, kind: "network", message: "Brave network request failed", retryable: true, cause: error });
		}

		const rateLimits = parseBraveRateLimits(response.headers);
		this.capacityTracker?.observe(rateLimits);
		const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-brave-request-id") ?? undefined;
		if (response.status === 401 || response.status === 403) {
			await cancelResponseBody(response);
			throw createProviderError({ provider: this.id, kind: "auth", message: `Brave rejected the API key (HTTP ${response.status})`, status: response.status, retryable: false, requestId, rateLimits });
		}
		if (response.status === 429) {
			await cancelResponseBody(response);
			throw createProviderError({ provider: this.id, kind: "rateLimit", message: "Brave rate limit exceeded", status: response.status, retryable: true, requestId, retryAfterMs: rateLimits?.retryAfterMs, rateLimits });
		}
		if (response.status < 200 || response.status >= 300) {
			await cancelResponseBody(response);
			throw createProviderError({ provider: this.id, kind: response.status === 400 || response.status === 422 ? "badRequest" : "http", message: `Brave search failed with HTTP ${response.status}`, status: response.status, retryable: response.status === 408 || response.status === 425 || response.status >= 500, requestId, rateLimits });
		}

		let payload: unknown;
		try {
			payload = JSON.parse(await readBoundedResponseText(response, this.maxResponseBytes, signal));
		} catch (error) {
			if (signal.aborted) {
				throw createProviderError({ provider: this.id, kind: "canceled", message: "Search canceled", retryable: false, cause: error });
			}
			throw createProviderError({ provider: this.id, kind: "malformed", message: "Brave returned a malformed or oversized JSON response", retryable: false, requestId, rateLimits, cause: error });
		}
		const normalizedResponse = normalizeBraveResponse(payload, normalized, { requestId, rateLimits });
		return { ...normalizedResponse, appliedOptions: plan.appliedOptions, warnings: plan.warnings };
	}
}

export function createBraveProvider(options: BraveAdapterOptions): BraveProvider {
	return new BraveProvider(options);
}
