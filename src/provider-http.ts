import type { ProviderId, ProviderRateLimitInfo, ProviderRateLimitWindow } from "./contracts";
import { createProviderError, isProviderError } from "./errors";
import { cancelResponseBody, readBoundedResponseText } from "./http";
import { normalizeSearchUrl } from "./search-cleanup";

export type SearchHttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_SEARCH_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface JsonRequestOptions {
	readonly provider: ProviderId;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: unknown;
	readonly method?: "GET" | "POST";
	readonly signal: AbortSignal;
	readonly fetchImpl: SearchHttpFetch;
	readonly maxResponseBytes?: number;
	readonly rateLimits?: ProviderRateLimitInfo;
}

export interface JsonResponse {
	readonly payload: unknown;
	readonly requestId?: string;
	readonly retryAfterMs?: number;
	readonly rateLimits?: ProviderRateLimitInfo;
}

function retryAfterMs(headers: Headers): number | undefined {
	const milliseconds = headers.get("retry-after-ms");
	if (milliseconds !== null && /^\d+(?:\.\d+)?$/.test(milliseconds.trim())) {
		const value = Number(milliseconds);
		if (Number.isFinite(value)) return Math.max(0, Math.round(value));
	}
	const retryAfter = headers.get("retry-after");
	if (retryAfter === null) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
		const value = Number(retryAfter);
		return Number.isFinite(value) ? Math.max(0, Math.round(value * 1_000)) : undefined;
	}
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function nonNegativeHeaderNumber(value: string | null): number | undefined {
	if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resetFromHeader(value: string | null): Pick<ProviderRateLimitWindow, "resetAt" | "resetAfterMs"> {
	const parsed = nonNegativeHeaderNumber(value);
	if (parsed === undefined) return {};
	if (parsed >= 1_000_000_000_000) {
		const date = new Date(parsed);
		return Number.isFinite(date.getTime()) ? { resetAt: date.toISOString() } : {};
	}
	if (parsed >= 1_000_000_000) {
		const date = new Date(parsed * 1_000);
		return Number.isFinite(date.getTime()) ? { resetAt: date.toISOString() } : {};
	}
	return { resetAfterMs: Math.round(parsed * 1_000) };
}

/** Parse standard quota headers without assuming provider-specific plans. */
export function parseProviderRateLimits(headers: Headers): ProviderRateLimitInfo | undefined {
	const header = (standard: string, xApi: string): string => headers.get(standard) ?? headers.get(xApi) ?? "";
	const limits = header("x-ratelimit-limit", "x-rate-limit-limit").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 8);
	const remaining = header("x-ratelimit-remaining", "x-rate-limit-remaining").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 8);
	const resets = header("x-ratelimit-reset", "x-rate-limit-reset").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 8);
	const windows: ProviderRateLimitWindow[] = [];
	const count = Math.max(limits.length, remaining.length, resets.length);
	for (let index = 0; index < count; index += 1) {
		const limit = nonNegativeHeaderNumber(limits[index] ?? null);
		const left = nonNegativeHeaderNumber(remaining[index] ?? null);
		const reset = resetFromHeader(resets[index] ?? null);
		if (limit === undefined && left === undefined && Object.keys(reset).length === 0) continue;
		windows.push({
			...(limit === undefined ? {} : { limit }),
			...(left === undefined ? {} : { remaining: left }),
			...reset,
			scope: `window-${index}`,
		});
	}
	const retryAfter = retryAfterMs(headers);
	if (windows.length === 0 && retryAfter === undefined) return undefined;
	return { windows, ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) };
}

function requestMetadata(response: Response): Pick<JsonResponse, "requestId" | "retryAfterMs" | "rateLimits"> {
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
	const delay = retryAfterMs(response.headers);
	const rateLimits = parseProviderRateLimits(response.headers);
	return {
		...(requestId === undefined ? {} : { requestId }),
		...(delay === undefined ? {} : { retryAfterMs: delay }),
		...(rateLimits === undefined ? {} : { rateLimits }),
	};
}

/** Perform one bounded JSON request. It never retries or follows provider fallbacks. */
export async function postJson(options: JsonRequestOptions): Promise<JsonResponse> {
	if (options.signal.aborted) {
		throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false });
	}
	let response: Response;
	const method = options.method ?? "POST";
	try {
		response = await options.fetchImpl(options.url, {
			method,
			headers: {
				...options.headers,
				accept: "application/json",
				...(method === "POST" ? { "content-type": "application/json" } : {}),
			},
			...(options.body === undefined ? {} : { body: method === "POST" ? JSON.stringify(options.body) : undefined }),
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal.aborted) {
			throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false, cause: error });
		}
		if (isProviderError(error)) throw error;
		throw createProviderError({ provider: options.provider, kind: "network", message: `${options.provider} search network request failed`, retryable: true, cause: error });
	}

	const metadata = requestMetadata(response);
	if (response.status === 401 || response.status === 403) {
		await cancelResponseBody(response);
		throw createProviderError({ provider: options.provider, kind: "auth", message: `${options.provider} search authentication failed (HTTP ${response.status})`, status: response.status, retryable: false, ...metadata, rateLimits: options.rateLimits ?? metadata.rateLimits });
	}
	if (response.status === 429) {
		await cancelResponseBody(response);
		throw createProviderError({ provider: options.provider, kind: "rateLimit", message: `${options.provider} search rate limit exceeded`, status: response.status, retryable: true, ...metadata, rateLimits: options.rateLimits ?? metadata.rateLimits });
	}
	if (response.status < 200 || response.status >= 300) {
		await cancelResponseBody(response);
		throw createProviderError({
			provider: options.provider,
			kind: response.status === 400 || response.status === 422 ? "badRequest" : "http",
			message: `${options.provider} search failed with HTTP ${response.status}`,
			status: response.status,
			retryable: response.status === 408 || response.status === 425 || response.status >= 500,
			...metadata,
			rateLimits: options.rateLimits ?? metadata.rateLimits,
		});
	}

	try {
		const text = await readBoundedResponseText(response, options.maxResponseBytes ?? DEFAULT_SEARCH_PROVIDER_RESPONSE_BYTES, options.signal);
		if (text.trim().length === 0) {
			throw createProviderError({ provider: options.provider, kind: "malformed", message: `${options.provider} returned an empty response`, retryable: false, ...metadata });
		}
		return {
			payload: JSON.parse(text) as unknown,
			...metadata,
			...(options.rateLimits === undefined && metadata.rateLimits === undefined ? {} : { rateLimits: options.rateLimits ?? metadata.rateLimits }),
		};
	} catch (error) {
		if (options.signal.aborted) {
			throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false, cause: error, ...metadata });
		}
		if (isProviderError(error)) throw error;
		throw createProviderError({ provider: options.provider, kind: "malformed", message: `${options.provider} returned malformed or oversized JSON`, retryable: false, cause: error, ...metadata });
	}
}

export function getJson(options: Omit<JsonRequestOptions, "body" | "method">): Promise<JsonResponse> {
	return postJson({ ...options, method: "GET" });
}

export function requireApiKey(provider: ProviderId, apiKey: string | undefined): string {
	if (apiKey === undefined || apiKey.trim().length === 0) {
		throw createProviderError({ provider, kind: "auth", message: `${provider} API key is not configured`, retryable: false });
	}
	return apiKey;
}

export function objectValue(value: unknown, label: string, provider: ProviderId): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw createProviderError({ provider, kind: "malformed", message: `${provider} returned malformed response (${label} is not an object)`, retryable: false });
	}
	return value as Record<string, unknown>;
}

export function optionalString(value: unknown, maxLength = Number.POSITIVE_INFINITY): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.slice(0, maxLength) : undefined;
}

export function httpSource(value: unknown, _provider: ProviderId): { url: string; domain: string } | undefined {
	const normalized = normalizeSearchUrl(value);
	return normalized === undefined ? undefined : { url: normalized.url, domain: normalized.domain };
}

export function optionalTimestamp(value: unknown, maxLength = 100): string | undefined {
	const candidate = optionalString(value, maxLength);
	return candidate !== undefined && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}
