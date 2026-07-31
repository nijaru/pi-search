import type { ProviderError, ProviderId, ProviderRateLimitInfo, RequestId } from "./contracts";

export interface ProviderErrorOptions {
	readonly provider: ProviderId;
	readonly kind: ProviderError["kind"];
	readonly message: string;
	readonly retryable: boolean;
	readonly status?: number;
	readonly requestId?: RequestId;
	readonly retryAfterMs?: number;
	readonly rateLimits?: ProviderRateLimitInfo;
	readonly cause?: unknown;
}

/** An adapter error with a stable, provider-neutral classification. */
export class SearchProviderError extends Error implements ProviderError {
	readonly provider: ProviderId;
	readonly kind: ProviderError["kind"];
	readonly retryable: boolean;
	readonly status?: number;
	readonly requestId?: RequestId;
	readonly retryAfterMs?: number;
	readonly rateLimits?: ProviderRateLimitInfo;

	constructor(options: ProviderErrorOptions) {
		super(options.message, { cause: options.cause });
		this.name = "SearchProviderError";
		this.provider = options.provider;
		this.kind = options.kind;
		this.retryable = options.retryable;
		this.status = options.status;
		this.requestId = options.requestId;
		this.retryAfterMs = options.retryAfterMs;
		this.rateLimits = options.rateLimits;
	}
}

export function isProviderError(error: unknown): error is ProviderError {
	return (
		error instanceof SearchProviderError ||
		(typeof error === "object" &&
			error !== null &&
			"provider" in error &&
			"kind" in error &&
			"retryable" in error &&
			error instanceof Error)
	);
}

export function createProviderError(options: ProviderErrorOptions): SearchProviderError {
	return new SearchProviderError(options);
}

export type SearchToolErrorCode =
	| "WEB_SEARCH_INVALID_REQUEST"
	| "WEB_SEARCH_AUTH"
	| "WEB_SEARCH_RATE_LIMIT"
	| "WEB_SEARCH_BAD_REQUEST"
	| "WEB_SEARCH_MALFORMED_RESPONSE"
	| "WEB_SEARCH_TIMEOUT"
	| "WEB_SEARCH_CANCELED"
	| "WEB_SEARCH_NETWORK"
	| "WEB_SEARCH_HTTP"
	| "WEB_SEARCH_UNSUPPORTED"
	| "WEB_SEARCH_PROVIDER_UNAVAILABLE"
	| "WEB_SEARCH_UNKNOWN"
	| "WEB_RESEARCH_INVALID_REQUEST"
	| "WEB_RESEARCH_BUDGET"
	| "WEB_RESEARCH_TIMEOUT"
	| "WEB_RESEARCH_CANCELED"
	| "WEB_RESEARCH_PROVIDER"
	| "WEB_RESEARCH_UNKNOWN";

/** A stable error shape thrown so Pi records an unsuccessful tool call. */
export class SearchToolError extends Error {
	readonly code: SearchToolErrorCode;
	readonly provider?: ProviderId;
	readonly kind?: ProviderError["kind"];
	readonly retryable?: boolean;
	readonly status?: number;
	readonly requestId?: RequestId;
	readonly retryAfterMs?: number;
	readonly rateLimits?: ProviderRateLimitInfo;

	constructor(
		code: SearchToolErrorCode,
		message: string,
		options: {
			readonly provider?: ProviderId;
			readonly kind?: ProviderError["kind"];
			readonly retryable?: boolean;
			readonly status?: number;
			readonly requestId?: RequestId;
			readonly retryAfterMs?: number;
			readonly rateLimits?: ProviderRateLimitInfo;
		} = {},
	) {
		super(`${code}: ${message}`);
		this.name = "SearchToolError";
		this.code = code;
		this.provider = options.provider;
		this.kind = options.kind;
		this.retryable = options.retryable;
		this.status = options.status;
		this.requestId = options.requestId;
		this.retryAfterMs = options.retryAfterMs;
		this.rateLimits = options.rateLimits;
	}
}

function providerDiagnosticMessage(error: ProviderError): string {
	const details = {
		provider: error.provider,
		...(error.status === undefined ? {} : { status: error.status }),
		...(error.requestId === undefined ? {} : { requestId: error.requestId.slice(0, 200) }),
		...(error.retryAfterMs === undefined ? {} : { retryAfterMs: Math.max(0, Math.round(error.retryAfterMs)) }),
		...(error.rateLimits === undefined
			? {}
			: {
				rateLimits: {
					windows: error.rateLimits.windows.slice(0, 8),
					...(error.rateLimits.retryAfterMs === undefined ? {} : { retryAfterMs: error.rateLimits.retryAfterMs }),
				},
			}),
	};
	return `${error.message} [${JSON.stringify(details)}]`;
}

/** Convert an adapter failure into the stable shape exposed by web_search. */
export function toSearchToolError(error: unknown, provider: ProviderId): SearchToolError {
	if (error instanceof SearchToolError) {
		return error;
	}
	if (isProviderError(error)) {
		const code: SearchToolErrorCode =
			error.kind === "auth"
				? "WEB_SEARCH_AUTH"
				: error.kind === "rateLimit"
					? "WEB_SEARCH_RATE_LIMIT"
					: error.kind === "badRequest"
						? "WEB_SEARCH_BAD_REQUEST"
						: error.kind === "malformed"
							? "WEB_SEARCH_MALFORMED_RESPONSE"
							: error.kind === "timeout"
								? "WEB_SEARCH_TIMEOUT"
								: error.kind === "canceled"
									? "WEB_SEARCH_CANCELED"
									: error.kind === "network"
										? "WEB_SEARCH_NETWORK"
											: error.kind === "unsupported"
												? "WEB_SEARCH_UNSUPPORTED"
													: error.kind === "http"
														? "WEB_SEARCH_HTTP"
														: error.kind === "unavailable"
															? "WEB_SEARCH_PROVIDER_UNAVAILABLE"
															: "WEB_SEARCH_UNKNOWN";
		return new SearchToolError(code, providerDiagnosticMessage(error), {
			provider: error.provider,
			kind: error.kind,
			retryable: error.retryable,
			status: error.status,
			requestId: error.requestId,
			retryAfterMs: error.retryAfterMs,
			rateLimits: error.rateLimits,
		});
	}
	const message = error instanceof Error ? error.message : "Unknown search failure";
	return new SearchToolError("WEB_SEARCH_UNKNOWN", message, { provider, kind: "unknown" });
}

export interface SearchToolFailureDetails {
	readonly code: SearchToolErrorCode;
	readonly provider?: ProviderId;
	readonly kind?: ProviderError["kind"];
	readonly retryable?: boolean;
	readonly status?: number;
	readonly requestId?: RequestId;
	readonly retryAfterMs?: number;
	readonly rateLimits?: ProviderRateLimitInfo;
}

export function searchToolFailureDetails(error: SearchToolError): SearchToolFailureDetails {
	return {
		code: error.code,
		...(error.provider === undefined ? {} : { provider: error.provider }),
		...(error.kind === undefined ? {} : { kind: error.kind }),
		...(error.retryable === undefined ? {} : { retryable: error.retryable }),
		...(error.status === undefined ? {} : { status: error.status }),
		...(error.requestId === undefined ? {} : { requestId: error.requestId }),
		...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
		...(error.rateLimits === undefined ? {} : { rateLimits: error.rateLimits }),
	};
}
