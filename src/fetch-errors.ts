export type FetchErrorKind =
	| "invalidRequest"
	| "ssrf"
	| "redirect"
	| "network"
	| "http"
	| "timeout"
	| "canceled"
	| "responseTooLarge"
	| "unsupportedContentType"
	| "extraction"
	| "unknown";

export interface FetchErrorOptions {
	readonly kind: FetchErrorKind;
	readonly message: string;
	readonly status?: number;
	readonly retryable?: boolean;
	readonly cause?: unknown;
}

export class SafeFetchError extends Error {
	readonly kind: FetchErrorKind;
	readonly status?: number;
	readonly retryable: boolean;

	constructor(options: FetchErrorOptions) {
		super(options.message, { cause: options.cause });
		this.name = "SafeFetchError";
		this.kind = options.kind;
		this.status = options.status;
		this.retryable = options.retryable ?? false;
	}
}

export type FetchToolErrorCode =
	| "WEB_FETCH_INVALID_REQUEST"
	| "WEB_FETCH_SSRF_BLOCKED"
	| "WEB_FETCH_REDIRECT_ERROR"
	| "WEB_FETCH_NETWORK"
	| "WEB_FETCH_HTTP"
	| "WEB_FETCH_TIMEOUT"
	| "WEB_FETCH_CANCELED"
	| "WEB_FETCH_RESPONSE_TOO_LARGE"
	| "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE"
	| "WEB_FETCH_EXTRACTION_FAILED"
	| "WEB_FETCH_UNKNOWN";

export class FetchToolError extends Error {
	readonly code: FetchToolErrorCode;
	readonly kind: FetchErrorKind;
	readonly status?: number;
	readonly retryable: boolean;

	constructor(options: {
		readonly code: FetchToolErrorCode;
		readonly kind: FetchErrorKind;
		readonly message: string;
		readonly status?: number;
		readonly retryable?: boolean;
	}) {
		super(`${options.code}: ${options.message}`);
		this.name = "FetchToolError";
		this.code = options.code;
		this.kind = options.kind;
		this.status = options.status;
		this.retryable = options.retryable ?? false;
	}
}

export function isSafeFetchError(error: unknown): error is SafeFetchError {
	return error instanceof SafeFetchError;
}

function errorCode(kind: FetchErrorKind): FetchToolErrorCode {
	switch (kind) {
		case "invalidRequest":
			return "WEB_FETCH_INVALID_REQUEST";
		case "ssrf":
			return "WEB_FETCH_SSRF_BLOCKED";
		case "redirect":
			return "WEB_FETCH_REDIRECT_ERROR";
		case "network":
			return "WEB_FETCH_NETWORK";
		case "http":
			return "WEB_FETCH_HTTP";
		case "timeout":
			return "WEB_FETCH_TIMEOUT";
		case "canceled":
			return "WEB_FETCH_CANCELED";
		case "responseTooLarge":
			return "WEB_FETCH_RESPONSE_TOO_LARGE";
		case "unsupportedContentType":
			return "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE";
		case "extraction":
			return "WEB_FETCH_EXTRACTION_FAILED";
		case "unknown":
			return "WEB_FETCH_UNKNOWN";
	}
}

export function toFetchToolError(error: unknown): FetchToolError {
	if (error instanceof FetchToolError) return error;
	if (isSafeFetchError(error)) {
		return new FetchToolError({
			code: errorCode(error.kind),
			kind: error.kind,
			message: error.message,
			status: error.status,
			retryable: error.retryable,
		});
	}
	return new FetchToolError({
		code: "WEB_FETCH_UNKNOWN",
		kind: "unknown",
		message: error instanceof Error ? error.message : "Unknown fetch failure",
	});
}

export interface FetchToolFailureDetails {
	readonly code: FetchToolErrorCode;
	readonly kind: FetchErrorKind;
	readonly status?: number;
	readonly retryable: boolean;
}

export function fetchToolFailureDetails(error: FetchToolError): FetchToolFailureDetails {
	return {
		code: error.code,
		kind: error.kind,
		...(error.status === undefined ? {} : { status: error.status }),
		retryable: error.retryable,
	};
}
