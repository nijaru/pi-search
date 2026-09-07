import type {
	Provider,
	ProviderCapabilities,
	ProviderContext,
	ProviderProfile,
	ProviderUsage,
	SearchOption,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchWarning,
} from "./contracts";
import { createProviderError } from "./errors";
import { httpSource, objectValue, optionalString, postJson, requireApiKey, type SearchHttpFetch } from "./provider-http";
import { validateSearchRequest } from "./search";

/**
 * Parallel Responses API — opt-in answer-synthesis provider.
 *
 * POST https://api.parallel.ai/v1/responses with model "parallel"; the
 * reasoning tier (low/medium/high, default medium) is selected through
 * `reasoning.effort` and grounds the answer in live web research
 * automatically. Citations arrive as `url_citation` annotations carrying
 * start/end indexes over the answer text. Registered only when
 * `PI_SEARCH_ENABLE_PARALLEL_RESPONSES=1`; explicit provider hint only —
 * never automatic routing, never the `native` alias.
 */

export const PARALLEL_RESPONSES_ENDPOINT = "https://api.parallel.ai/v1/responses";
export const DEFAULT_PARALLEL_RESPONSES_BYTES = 4 * 1024 * 1024;
const MAX_ANSWER_LENGTH = 8_000;
const MAX_SOURCE_URL_LENGTH = 8_192;
const MAX_SOURCE_TITLE_LENGTH = 500;
const EFFORTS = ["low", "medium", "high"] as const;
export type ParallelResponsesEffort = (typeof EFFORTS)[number];

export interface ParallelResponsesAdapterOptions {
	readonly apiKey?: string;
	readonly endpoint?: string;
	readonly fetchImpl?: SearchHttpFetch;
	readonly maxResponseBytes?: number;
}

const capabilities: ProviderCapabilities = {
	semantic: true,
	freshness: true,
	excerpts: false,
	nativeGrounding: true,
	searchContextSize: true,
};

const profile: ProviderProfile = {
	auth: "environment",
	costModel: "usage-based",
};

export interface ParallelResponsesPlan {
	readonly body: Record<string, unknown>;
	readonly appliedOptions: readonly SearchOption[];
	readonly warnings: readonly SearchWarning[];
}

/** Map the contract's provider-native context size onto the reasoning tier. */
export function effortFor(request: SearchRequest): ParallelResponsesEffort {
	return request.searchContextSize ?? "medium";
}

export function buildParallelResponsesRequest(request: SearchRequest): ParallelResponsesPlan {
	const normalized = validateSearchRequest(request);
	const hardConstraints: SearchOption[] = [];
	if (normalized.domains?.include?.length || normalized.domains?.exclude?.length) hardConstraints.push("domains");
	if (normalized.dateRange !== undefined) hardConstraints.push("dateRange");
	if (normalized.social !== undefined) hardConstraints.push("social");
	if (normalized.returnTokenBudget !== undefined) hardConstraints.push("returnTokenBudget");
	if (normalized.externalWebAccess !== undefined) hardConstraints.push("externalWebAccess");
	if (normalized.userLocation !== undefined) hardConstraints.push("userLocation");
	if (normalized.searchContentTypes !== undefined) hardConstraints.push("searchContentTypes");
	if (normalized.imageSettings !== undefined) hardConstraints.push("imageSettings");
	if (hardConstraints.length > 0) {
		throw createProviderError({
			provider: "parallel-responses",
			kind: "unsupported",
			message: `Parallel Responses does not expose ${hardConstraints.join(", ")} controls`,
			retryable: false,
		});
	}
	const warnings: SearchWarning[] = [];
	if (normalized.mode === "keyword") warnings.push({ code: "unsupported-option", option: "mode", message: "Parallel Responses researches the question semantically; keyword-only ranking is not guaranteed" });
	if (normalized.mode === "fresh") warnings.push({ code: "unsupported-option", option: "mode", message: "Parallel Responses uses current sources but does not guarantee a freshness-only ranking" });
	if (normalized.maxResults !== undefined) warnings.push({ code: "unsupported-option", option: "maxResults", message: "Parallel Responses returns the sources its research cited; the result count is not configurable" });
	const appliedOptions: SearchOption[] = ["mode", ...(normalized.searchContextSize === undefined ? [] : ["searchContextSize" as const])];
	return {
		body: {
			model: "parallel",
			input: normalized.query,
			reasoning: { effort: effortFor(normalized) },
		},
		appliedOptions,
		warnings,
	};
}

function malformed(message: string): never {
	throw createProviderError({ provider: "parallel-responses", kind: "malformed", message: `Parallel Responses returned a malformed response (${message})`, retryable: false });
}

interface CitationCandidate {
	readonly url: string;
	readonly title?: string;
	readonly startIndex?: number;
	readonly endIndex?: number;
}

/** Collect message output text and its url_citation annotations. */
function answerFromPayload(payload: unknown): { text: string; citations: CitationCandidate[] } {
	const root = objectValue(payload, "response", "parallel-responses");
	const output = Array.isArray(root.output) ? root.output : malformed("output is not an array");
	let text: string | undefined;
	const citations: CitationCandidate[] = [];
	for (const item of output) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (record.type !== "message") continue;
		const content = Array.isArray(record.content) ? record.content : [];
		for (const part of content) {
			if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
			const contentPart = part as Record<string, unknown>;
			if (contentPart.type !== "output_text" || typeof contentPart.text !== "string") continue;
			text = text === undefined ? contentPart.text : `${text}\n${contentPart.text}`;
			for (const annotation of Array.isArray(contentPart.annotations) ? contentPart.annotations : []) {
				if (typeof annotation !== "object" || annotation === null || Array.isArray(annotation)) continue;
				const record2 = annotation as Record<string, unknown>;
				if (record2.type !== "url_citation") continue;
				const parsed = httpSource(record2.url, "parallel-responses");
				if (parsed === undefined || parsed.url.length > MAX_SOURCE_URL_LENGTH) continue;
				citations.push({
					url: parsed.url,
					...(optionalString(record2.title, MAX_SOURCE_TITLE_LENGTH) === undefined ? {} : { title: optionalString(record2.title, MAX_SOURCE_TITLE_LENGTH) }),
					...(typeof record2.start_index === "number" && Number.isFinite(record2.start_index) && record2.start_index >= 0 ? { startIndex: Math.round(record2.start_index) } : {}),
					...(typeof record2.end_index === "number" && Number.isFinite(record2.end_index) && record2.end_index >= 0 ? { endIndex: Math.round(record2.end_index) } : {}),
				});
			}
		}
	}
	if (text === undefined) malformed("no message output text");
	return { text, citations };
}

function usageFromPayload(root: Record<string, unknown>): ProviderUsage | undefined {
	const value = root.usage;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const usage = value as Record<string, unknown>;
	const number = (key: string): number | undefined => typeof usage[key] === "number" && Number.isFinite(usage[key] as number) && (usage[key] as number) >= 0 ? usage[key] as number : undefined;
	const inputTokens = number("input_tokens");
	const outputTokens = number("output_tokens");
	const totalTokens = number("total_tokens");
	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens, billedUnits: totalTokens, billedUnit: "tokens" }),
	};
}

export function normalizeParallelResponsesPayload(payload: unknown, request: SearchRequest): SearchResponse {
	const normalized = validateSearchRequest(request);
	const root = objectValue(payload, "response", "parallel-responses");
	const { text, citations: rawCitations } = answerFromPayload(root);
	if (text.trim().length === 0) malformed("answer text is empty");
	const limitedText = text.slice(0, MAX_ANSWER_LENGTH);

	// Deduplicate citations by URL, preserving first-seen order and indexes.
	const byUrl = new Map<string, CitationCandidate>();
	for (const citation of rawCitations) {
		if (!byUrl.has(citation.url)) byUrl.set(citation.url, citation);
	}
	const results: SearchResult[] = [];
	for (const citation of byUrl.values()) {
		const parsed = httpSource(citation.url, "parallel-responses");
		if (parsed === undefined) continue;
		results.push({
			url: parsed.url,
			...(citation.title === undefined ? {} : { title: citation.title }),
			domain: parsed.domain,
			provider: "parallel-responses",
			searchQuery: normalized.query,
		});
	}
	if (results.length === 0) malformed("answer cites no HTTP sources");
	const answer = {
		text: limitedText,
		contentTrust: "untrusted" as const,
		provider: "parallel-responses" as const,
		citations: [...byUrl.values()].slice(0, normalized.maxResults ?? 10).map((citation) => ({
			url: citation.url,
			...(citation.title === undefined ? {} : { title: citation.title }),
			...(citation.startIndex === undefined ? {} : { startIndex: citation.startIndex }),
			...(citation.endIndex === undefined ? {} : { endIndex: citation.endIndex }),
		})),
	};
	return {
		query: normalized.query,
		results,
		...(normalized.answerMode === "evidence" ? {} : { answer }),
		provider: "parallel-responses",
		appliedOptions: [],
		warnings: [],
		...(usageFromPayload(root) === undefined ? {} : { usage: usageFromPayload(root) }),
	};
}

/** Response id from the payload, used when the transport supplied none. */
export function parallelResponsesRequestId(payload: unknown): string | undefined {
	const root = objectValue(payload, "response", "parallel-responses");
	return optionalString(root.id, 500);
}

export class ParallelResponsesProvider implements Provider {
	readonly id = "parallel-responses" as const;
	readonly capabilities = capabilities;
	readonly profile = profile;
	private readonly apiKey?: string;
	private readonly endpoint: string;
	private readonly fetchImpl: SearchHttpFetch;
	private readonly maxResponseBytes: number;

	constructor(options: ParallelResponsesAdapterOptions = {}) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint ?? PARALLEL_RESPONSES_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? (fetch as SearchHttpFetch);
		this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_PARALLEL_RESPONSES_BYTES;
		if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("Parallel Responses maxResponseBytes must be a positive integer");
	}

	async search(request: SearchRequest, signal: AbortSignal, _context: ProviderContext): Promise<SearchResponse> {
		const normalized = validateSearchRequest(request);
		const plan = buildParallelResponsesRequest(normalized);
		const result = await postJson({
			provider: this.id,
			url: this.endpoint,
			headers: { authorization: `Bearer ${requireApiKey(this.id, this.apiKey)}` },
			body: plan.body,
			signal,
			fetchImpl: this.fetchImpl,
			maxResponseBytes: this.maxResponseBytes,
		});
		const response = normalizeParallelResponsesPayload(result.payload, normalized);
		const requestId = result.requestId ?? parallelResponsesRequestId(result.payload);
		return {
			...response,
			...(requestId === undefined ? {} : { requestId }),
			appliedOptions: plan.appliedOptions,
			warnings: [...plan.warnings, ...response.warnings],
		};
	}
}

export function createParallelResponsesProvider(options: ParallelResponsesAdapterOptions): ParallelResponsesProvider {
	return new ParallelResponsesProvider(options);
}
