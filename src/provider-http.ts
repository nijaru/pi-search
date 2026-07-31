import type { ProviderId, ProviderRateLimitInfo } from "./contracts";
import { createProviderError, isProviderError } from "./errors";
import { cancelResponseBody, readBoundedResponseText } from "./http";

export type SearchHttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_SEARCH_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface JsonRequestOptions {
	readonly provider: ProviderId;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
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

function requestMetadata(response: Response): Pick<JsonResponse, "requestId" | "retryAfterMs"> {
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
	const delay = retryAfterMs(response.headers);
	return {
		...(requestId === undefined ? {} : { requestId }),
		...(delay === undefined ? {} : { retryAfterMs: delay }),
	};
}

/** Perform one bounded JSON request. It never retries or follows provider fallbacks. */
export async function postJson(options: JsonRequestOptions): Promise<JsonResponse> {
	if (options.signal.aborted) {
		throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false });
	}
	let response: Response;
	try {
		response = await options.fetchImpl(options.url, {
			method: "POST",
			headers: { ...options.headers, accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(options.body),
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
		throw createProviderError({ provider: options.provider, kind: "auth", message: `${options.provider} search authentication failed (HTTP ${response.status})`, status: response.status, retryable: false, ...metadata, rateLimits: options.rateLimits });
	}
	if (response.status === 429) {
		await cancelResponseBody(response);
		throw createProviderError({ provider: options.provider, kind: "rateLimit", message: `${options.provider} search rate limit exceeded`, status: response.status, retryable: true, ...metadata, rateLimits: options.rateLimits });
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
			rateLimits: options.rateLimits,
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
			...(options.rateLimits === undefined ? {} : { rateLimits: options.rateLimits }),
		};
	} catch (error) {
		if (options.signal.aborted) {
			throw createProviderError({ provider: options.provider, kind: "canceled", message: "Search canceled", retryable: false, cause: error, ...metadata });
		}
		if (isProviderError(error)) throw error;
		throw createProviderError({ provider: options.provider, kind: "malformed", message: `${options.provider} returned malformed or oversized JSON`, retryable: false, cause: error, ...metadata });
	}
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

export function httpSource(value: unknown, provider: ProviderId): { url: string; domain: string } | undefined {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return { url: url.toString(), domain: url.hostname.toLowerCase() };
	} catch {
		return undefined;
	}
}

export function optionalTimestamp(value: unknown, maxLength = 100): string | undefined {
	const candidate = optionalString(value, maxLength);
	return candidate !== undefined && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}
