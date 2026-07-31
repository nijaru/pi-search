import type { ProviderError, ProviderId } from "./contracts";

export interface ProviderErrorOptions {
	readonly provider: ProviderId;
	readonly kind: ProviderError["kind"];
	readonly message: string;
	readonly retryable: boolean;
	readonly status?: number;
	readonly cause?: unknown;
}

/** An adapter error with a stable, provider-neutral classification. */
export class SearchProviderError extends Error implements ProviderError {
	readonly provider: ProviderId;
	readonly kind: ProviderError["kind"];
	readonly retryable: boolean;
	readonly status?: number;

	constructor(options: ProviderErrorOptions) {
		super(options.message, { cause: options.cause });
		this.name = "SearchProviderError";
		this.provider = options.provider;
		this.kind = options.kind;
		this.retryable = options.retryable;
		this.status = options.status;
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
	| "EXA_AUTH"
	| "EXA_RATE_LIMIT"
	| "EXA_BAD_REQUEST"
	| "EXA_MALFORMED_RESPONSE"
	| "EXA_TIMEOUT"
	| "EXA_CANCELED"
	| "EXA_NETWORK"
	| "EXA_HTTP"
	| "EXA_UNSUPPORTED"
	| "EXA_UNKNOWN";

/** A stable error shape returned as an unsuccessful Pi tool result. */
export class SearchToolError extends Error {
	readonly code: SearchToolErrorCode;
	readonly provider?: ProviderId;
	readonly kind?: ProviderError["kind"];
	readonly retryable?: boolean;
	readonly status?: number;

	constructor(
		code: SearchToolErrorCode,
		message: string,
		options: {
			readonly provider?: ProviderId;
			readonly kind?: ProviderError["kind"];
			readonly retryable?: boolean;
			readonly status?: number;
		} = {},
	) {
		super(message);
		this.name = "SearchToolError";
		this.code = code;
		this.provider = options.provider;
		this.kind = options.kind;
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

function providerCode(provider: ProviderId, suffix: string): SearchToolErrorCode {
	if (provider === "exa") {
		return `EXA_${suffix}` as SearchToolErrorCode;
	}
	return "EXA_UNKNOWN";
}

/** Convert an adapter failure into the stable shape exposed by web_search. */
export function toSearchToolError(error: unknown, provider: ProviderId): SearchToolError {
	if (error instanceof SearchToolError) {
		return error;
	}
	if (isProviderError(error)) {
		const suffix =
			error.kind === "auth"
				? "AUTH"
				: error.kind === "rateLimit"
					? "RATE_LIMIT"
					: error.kind === "badRequest"
						? "BAD_REQUEST"
						: error.kind === "malformed"
							? "MALFORMED_RESPONSE"
							: error.kind === "timeout"
								? "TIMEOUT"
									: error.kind === "canceled"
										? "CANCELED"
											: error.kind === "network"
												? "NETWORK"
													: error.kind === "unsupported"
														? "UNSUPPORTED"
															: error.kind === "http"
																? "HTTP"
																	: "UNKNOWN";
		return new SearchToolError(providerCode(error.provider, suffix), error.message, {
			provider: error.provider,
			kind: error.kind,
			retryable: error.retryable,
			status: error.status,
		});
	}
	const message = error instanceof Error ? error.message : "Unknown search failure";
	return new SearchToolError(providerCode(provider, "UNKNOWN"), message, { provider, kind: "unknown" });
}

export interface SearchToolFailureDetails {
	readonly code: SearchToolErrorCode;
	readonly provider?: ProviderId;
	readonly kind?: ProviderError["kind"];
	readonly retryable?: boolean;
	readonly status?: number;
}

export function searchToolFailureDetails(error: SearchToolError): SearchToolFailureDetails {
	return {
		code: error.code,
		...(error.provider === undefined ? {} : { provider: error.provider }),
		...(error.kind === undefined ? {} : { kind: error.kind }),
		...(error.retryable === undefined ? {} : { retryable: error.retryable }),
		...(error.status === undefined ? {} : { status: error.status }),
	};
}
