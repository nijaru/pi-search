import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderProfile,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchWarning,
} from "./contracts";
import { createProviderError, isProviderError } from "./errors";
import { validateSearchRequest } from "./search";

export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

export type ExaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExaAdapterOptions {
	/** The key is supplied by the construction boundary; this adapter never reads environment state. */
	readonly apiKey?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: ExaFetch;
}

interface ExaSearchPayload {
	query: string;
	numResults: number;
	type?: "neural" | "keyword";
	includeDomains?: readonly string[];
	excludeDomains?: readonly string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
	contents?: {
		highlights: true;
	};
}

interface ExaResultPayload {
	readonly url: string;
	readonly title?: string | null;
	readonly publishedDate?: string | null;
	readonly id?: string | null;
	readonly text?: string | null;
	readonly summary?: string | null;
	readonly highlights?: readonly string[] | null;
	readonly score?: number | null;
}

const capabilities: ProviderCapabilities = {
	semantic: true,
	excerpts: true,
	domainFilter: true,
	dateFilter: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "usage-based",
};

const isoTimestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T.*)?$/;

function malformed(message: string, cause?: unknown): never {
	throw createProviderError({
		provider: "exa",
		kind: "malformed",
		message: `Exa returned a malformed response (${message})`,
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

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		return malformed(`${label} is not a string`);
	}
	return value;
}

function optionalPublishedAt(value: unknown, label: string): string | undefined {
	const date = optionalString(value, label);
	if (date !== undefined && (!isoTimestampPattern.test(date) || !Number.isFinite(Date.parse(date)))) {
		return malformed(`${label} is not an ISO timestamp`);
	}
	return date;
}

function optionalHighlights(value: unknown, label: string): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((highlight) => typeof highlight !== "string")) {
		return malformed(`${label} is not an array of strings`);
	}
	return value as string[];
}

function optionalScore(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return malformed(`${label} is not a finite number`);
	}
	return Math.min(1, Math.max(0, value));
}

function normalizedUrl(value: unknown, label: string): string {
	const url = optionalString(value, label);
	if (url === undefined) {
		return malformed(`${label} is missing`);
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return malformed(`${label} is not an HTTP(S) URL`);
		}
	} catch (error) {
		return malformed(`${label} is not a valid URL`, error);
	}
	return url;
}

function requestUsage(root: Record<string, unknown>): SearchResponse["usage"] {
	const cost = root.costDollars;
	if (cost === undefined || cost === null) {
		return undefined;
	}
	const costObject = objectValue(cost, "costDollars");
	const total = costObject.total;
	if (total === undefined || total === null) {
		return undefined;
	}
	if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
		return malformed("costDollars.total is not a non-negative number");
	}
	return { costUsd: total };
}

function resultFromPayload(value: unknown, query: string, wantHighlights: boolean): SearchResult {
	const result = objectValue(value, "results[]") as Partial<ExaResultPayload>;
	const url = normalizedUrl(result.url, "results[].url");
	const title = optionalString(result.title, "results[].title");
	const publishedAt = optionalPublishedAt(result.publishedDate, "results[].publishedDate");
	const sourceId = optionalString(result.id, "results[].id");
	const text = optionalString(result.text, "results[].text");
	const summary = optionalString(result.summary, "results[].summary");
	const highlights = optionalHighlights(result.highlights, "results[].highlights");
	const score = optionalScore(result.score, "results[].score");
	const excerpt = text ?? summary ?? highlights?.join(" ");
	const parsed = new URL(url);

	return {
		url,
		...(title === undefined ? {} : { title }),
		domain: parsed.hostname.toLowerCase(),
		...(publishedAt === undefined ? {} : { publishedAt }),
		...(excerpt === undefined ? {} : { excerpt }),
		...(wantHighlights && highlights === undefined ? {} : wantHighlights ? { highlights } : {}),
		provider: "exa",
		searchQuery: query,
		...(sourceId === undefined ? {} : { sourceId }),
		...(score === undefined ? {} : { score }),
	};
}

/** Normalize an Exa `/search` response without exposing the provider payload. */
export function normalizeExaResponse(
	payload: unknown,
	request: SearchRequest,
): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response");
	if (!Array.isArray(root.results)) {
		return malformed("results is not an array");
	}
	const requestId = optionalString(root.requestId, "requestId");
	const results = root.results
		.slice(0, normalized.maxResults)
		.map((result) => resultFromPayload(result, normalized.query, normalized.wantHighlights === true));
	const usage = requestUsage(root);

	return {
		query: normalized.query,
		results,
		provider: "exa",
		appliedOptions: [],
		warnings: [],
		...(requestId === undefined ? {} : { requestId }),
		...(usage === undefined ? {} : { usage }),
	};
}

export interface ExaRequestPlan {
	readonly body: ExaSearchPayload;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

/** Build the provider request and make unsupported options explicit. */
export function buildExaRequest(request: SearchRequest): ExaRequestPlan {
	const normalized = validateSearchRequest(request);
	const appliedOptions: SearchOption[] = ["maxResults"];
	const warnings: SearchWarning[] = [];
	const body: ExaSearchPayload = {
		query: normalized.query,
		numResults: normalized.maxResults ?? 10,
	};

	switch (normalized.mode) {
		case "auto":
			appliedOptions.push("mode");
			break;
		case "semantic":
			body.type = "neural";
			appliedOptions.push("mode");
			break;
		case "keyword":
			body.type = "keyword";
			appliedOptions.push("mode");
			break;
		default:
			warnings.push({
				code: "unsupported-option",
				option: "mode",
				message: `Exa does not provide ${String(normalized.mode)} search semantics; provider default used`,
			});
	}

	const include = normalized.domains?.include;
	const exclude = normalized.domains?.exclude;
	if (include !== undefined && include.length > 0) {
		body.includeDomains = include;
		appliedOptions.push("domains");
	}
	if (exclude !== undefined && exclude.length > 0) {
		body.excludeDomains = exclude;
		if (!appliedOptions.includes("domains")) {
			appliedOptions.push("domains");
		}
	}
	if (normalized.publishedAfter !== undefined) {
		body.startPublishedDate = normalized.publishedAfter;
		appliedOptions.push("publishedAfter");
	}
	if (normalized.publishedBefore !== undefined) {
		body.endPublishedDate = normalized.publishedBefore;
		appliedOptions.push("publishedBefore");
	}
	if (normalized.wantHighlights === true) {
		body.contents = { highlights: true };
		appliedOptions.push("wantHighlights");
	}
	if (normalized.wantAnswer === true) {
		warnings.push({
			code: "unsupported-option",
			option: "wantAnswer",
			message: "Exa evidence search does not request a synthesized answer",
		});
	}
	return { body, appliedOptions, warnings };
}

export class ExaProvider implements Provider {
	readonly id = "exa" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: ExaFetch;

	constructor(options: ExaAdapterOptions) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? EXA_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as ExaFetch);
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildExaRequest(normalized);
		if (signal.aborted) {
			throw createProviderError({
				provider: this.id,
				kind: "canceled",
				message: "Search canceled",
				retryable: false,
			});
		}
		const apiKey = this.apiKey;
		if (apiKey === undefined || apiKey.trim().length === 0) {
			throw createProviderError({
				provider: this.id,
				kind: "auth",
				message: "Exa API key is not configured",
				retryable: false,
			});
		}

		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-api-key": apiKey,
				},
				body: JSON.stringify(plan.body),
				signal,
			});
		} catch (error) {
			if (signal.aborted) {
				throw createProviderError({
					provider: this.id,
					kind: "canceled",
					message: "Search canceled",
					retryable: false,
					cause: error,
				});
			}
			if (isProviderError(error)) {
				throw error;
			}
			throw createProviderError({
				provider: this.id,
				kind: "network",
				message: "Exa network request failed",
				retryable: true,
				cause: error,
			});
		}

		if (response.status === 401 || response.status === 403) {
			throw createProviderError({
				provider: this.id,
				kind: "auth",
				message: `Exa rejected the API key (HTTP ${response.status})`,
				status: response.status,
				retryable: false,
			});
		}
		if (response.status === 429) {
			throw createProviderError({
				provider: this.id,
				kind: "rateLimit",
				message: "Exa rate limit exceeded",
				status: response.status,
				retryable: true,
			});
		}
		if (response.status < 200 || response.status >= 300) {
			throw createProviderError({
				provider: this.id,
				kind: response.status === 400 ? "badRequest" : "http",
				message: `Exa search failed with HTTP ${response.status}`,
				status: response.status,
				retryable: response.status === 408 || response.status >= 500,
			});
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw createProviderError({
				provider: this.id,
				kind: "malformed",
				message: "Exa returned a malformed JSON response",
				retryable: false,
				cause: error,
			});
		}

		const normalizedResponse = normalizeExaResponse(payload, normalized);
		return {
			...normalizedResponse,
			appliedOptions: plan.appliedOptions,
			warnings: plan.warnings,
		};
	}
}

export function createExaProvider(options: ExaAdapterOptions): ExaProvider {
	return new ExaProvider(options);
}
